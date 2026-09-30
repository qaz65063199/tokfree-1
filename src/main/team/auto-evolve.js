'use strict';
/**
 * 自动进化引擎（Auto-Evolve）—— Agent 自工程化的「自动化」环节
 *
 * 把已有的 4 个自工程化模块（trace / retrospect / skill-forge / skill-evolver）
 * 从「手动调用」升级为「自动触发」：
 *
 *  1. 自动复盘触发器（Level 1 自动化）
 *     - shouldAutoRetrospect(trace)：纯规则判断某条轨迹是否值得复盘
 *       （有失败步骤 或 耗时长 或 步骤多）
 *     - triggerRetrospect(taskId)：任务结束时调用，值得复盘才生成分析
 *     - 只负责「判断 + 生成分析」，不直接调 AI（AI 调用由上层决定）
 *
 *  2. 技能优化器（Level 3 批量环节）
 *     - runOptimizePass()：批量分析所有技能，为待优化技能生成优化建议
 *       （成功率低 → 建议改写 description/steps；耗时长 → 建议简化）
 *     - runDailyMaintenance()：每日维护 = 淘汰归档 + 生成优化建议
 *
 *  3. 定时器（可选）
 *     - startScheduler() / stopScheduler()：默认 24 小时跑一次每日维护
 *
 * 设计原则：
 *  - 纯 Node 模块，仅依赖 src/main/team/ 下已有模块（惰性 require）
 *  - 容错：任何异常都静默降级，绝不抛出、绝不改变现有行为
 *  - 不自动改技能/不自动调 AI：只产出「判断 + 建议」，等上层确认
 */
const trace = require('./trace');
const retrospect = require('./retrospect');
// 自进化飞轮总开关（默认关；缺失时视为关闭）
let evolutionSwitch = null;
try { evolutionSwitch = require('./evolution-switch'); } catch (_) { evolutionSwitch = null; }

/** 总开关是否开启 */
function isEvolutionEnabled() {
  try { return !!(evolutionSwitch && evolutionSwitch.isEnabled()); } catch (_) { return false; }
}

// ========== 配置 ==========
const CONFIG = {
  // 自动复盘触发阈值（满足任一即值得复盘）
  errorThreshold: 1,          // 失败步骤数 >= 此值
  durationThresholdMs: 60000, // 墙钟耗时 >= 此值（60s）
  stepThreshold: 30,          // 步骤数 >= 此值
  // 优化建议阈值（与 skill-evolver.CONFIG 对齐）
  optimizeSuccessRate: 0.7,   // 成功率低于此值 → 建议改写 description/steps
  optimizeAvgMs: 30000,       // 平均耗时超过此值 → 建议简化
  // 定时器
  intervalMs: 24 * 60 * 60 * 1000, // 默认 24 小时
};

function num(v) {
  return (typeof v === 'number' && isFinite(v)) ? v : 0;
}

/** 惰性加载 skill-evolver（其顶层依赖 electron，测试环境由 mock 提供） */
function loadEvolver(opts) {
  if (opts && opts.evolver) return opts.evolver;
  return require('./skill-evolver');
}

/**
 * 从轨迹（完整 trace 或 listTraces 摘要）提取统一指标。
 * 兼容两种形态：
 *  - 完整 trace：有 steps 数组 → 现场统计 errorCount/durationMs/stepCount
 *  - 摘要：直接带 errorCount/durationMs/stepCount 字段
 * @param {object} t
 * @returns {{errorCount:number, durationMs:number, stepCount:number}}
 */
function summarizeTrace(t) {
  const out = { errorCount: 0, durationMs: 0, stepCount: 0 };
  if (!t || typeof t !== 'object') return out;

  if (Array.isArray(t.steps)) {
    out.stepCount = t.steps.length;
    let errs = 0;
    let stepMs = 0;
    for (const s of t.steps) {
      if (!s) continue;
      if (s.success === false) errs++;
      stepMs += num(s.durationMs);
    }
    out.errorCount = errs;
    // 优先用墙钟耗时（更贴近真实感知），缺失则退化为步骤耗时之和
    let wall = 0;
    if (t.startedAt && t.endedAt) {
      const d = Date.parse(t.endedAt) - Date.parse(t.startedAt);
      if (isFinite(d) && d >= 0) wall = d;
    }
    out.durationMs = wall > 0 ? wall : stepMs;
    return out;
  }

  out.errorCount = num(t.errorCount);
  out.stepCount = num(t.stepCount);
  out.durationMs = num(t.durationMs);
  return out;
}

/**
 * 纯规则判断：某条轨迹是否「值得复盘」。
 * 满足任一即返回 true：失败步骤 >= errorThreshold / 耗时 >= durationThresholdMs / 步骤 >= stepThreshold
 * @param {object} t 完整 trace 或摘要
 * @param {object} [opts] 可覆盖 CONFIG 阈值
 * @returns {boolean}
 */
function shouldAutoRetrospect(t, opts) {
  try {
    const o = opts || {};
    const errT = typeof o.errorThreshold === 'number' ? o.errorThreshold : CONFIG.errorThreshold;
    const durT = typeof o.durationThresholdMs === 'number' ? o.durationThresholdMs : CONFIG.durationThresholdMs;
    const stepT = typeof o.stepThreshold === 'number' ? o.stepThreshold : CONFIG.stepThreshold;
    const m = summarizeTrace(t);
    return m.errorCount >= errT || m.durationMs >= durT || m.stepCount >= stepT;
  } catch (e) {
    return false;
  }
}

/**
 * 任务结束时调用：若轨迹值得复盘，生成规则分析。
 * 不直接调 AI —— 只返回 { shouldRetrospect, analysis }，由上层决定是否进一步调 AI。
 * @param {string} taskId
 * @param {object} [opts]
 *   - trace / retrospect：注入模块（测试用）
 *   - errorThreshold / durationThresholdMs / stepThreshold：阈值覆盖
 * @returns {{taskId:string|null, shouldRetrospect:boolean, analysis:object|null, metrics?:object, reason?:string, error?:string}}
 */
function triggerRetrospect(taskId, opts) {
  const o = opts || {};
  try {
    if (!taskId) return { taskId: null, shouldRetrospect: false, analysis: null, reason: '缺少 taskId' };
    const traceMod = o.trace || trace;
    const t = traceMod.getTrace(taskId);
    if (!t) return { taskId: taskId, shouldRetrospect: false, analysis: null, reason: '轨迹不存在' };

    const metrics = summarizeTrace(t);
    if (!shouldAutoRetrospect(t, o)) {
      return { taskId: taskId, shouldRetrospect: false, analysis: null, metrics: metrics, reason: '轨迹平稳，无需复盘' };
    }

    const retroMod = o.retrospect || retrospect;
    const analysis = retroMod.analyzeTrace(t);
    return { taskId: taskId, shouldRetrospect: true, analysis: analysis, metrics: metrics };
  } catch (e) {
    return { taskId: taskId || null, shouldRetrospect: false, analysis: null, error: e.message };
  }
}

/** 由分析出的技能问题生成「优化建议」文本列表 */
function buildAdvice(item) {
  const advice = [];
  const rate = item && item.rate;
  const avgMs = item && item.avgMs;

  if (typeof rate === 'number' && rate < CONFIG.optimizeSuccessRate) {
    advice.push('成功率偏低（' + Math.round(rate * 100) + '%）：建议改写 description，补齐 "Use when" 触发词与边界条件以减少误用；并在正文「步骤」中补充前置校验与失败回退。');
  }
  if (typeof avgMs === 'number' && avgMs > CONFIG.optimizeAvgMs) {
    advice.push('平均耗时偏长（' + avgMs + 'ms）：建议简化步骤、合并重复操作，或缩小每步处理规模（分批/缩小读取范围）。');
  }
  if (advice.length === 0) {
    advice.push('（无明显问题，建议保持观察）');
  }
  return advice;
}

/**
 * 批量分析所有技能，为「待优化」技能生成优化建议（不自动改技能，等上层确认）。
 * @param {object} [opts]
 *   - evolver：注入的 skill-evolver 模块（测试用）
 * @returns {{generatedAt:string, total:number, suggestions:Array, summary?:object, error?:string}}
 */
function runOptimizePass(opts) {
  const o = opts || {};
  try {
    const evolver = loadEvolver(o);
    const report = evolver.analyze();
    const list = (report && Array.isArray(report.needOptimize)) ? report.needOptimize : [];

    const suggestions = list.map(function (item) {
      const it = item || {};
      return {
        name: it.name,
        rate: typeof it.rate === 'number' ? it.rate : null,
        avgMs: typeof it.avgMs === 'number' ? it.avgMs : null,
        uses: it.uses,
        reason: it.reason || '',
        advice: buildAdvice(it),
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      total: suggestions.length,
      suggestions: suggestions,
      summary: report && report.summary,
    };
  } catch (e) {
    return { generatedAt: new Date().toISOString(), total: 0, suggestions: [], error: e.message };
  }
}

/**
 * 每日维护：淘汰低效技能（归档） + 生成优化建议。
 * @param {object} [opts]
 *   - evolver：注入的 skill-evolver 模块（测试用）
 * @returns {{ranAt:string, archived:number, archive:object, optimize:object, optimizeCount:number}}
 */
function runDailyMaintenance(opts) {
  const o = opts || {};
  let evolver = null;
  try { evolver = loadEvolver(o); } catch (e) { evolver = null; }

  let archive = { archived: 0, details: [] };
  if (evolver && typeof evolver.runArchivePass === 'function') {
    try { archive = evolver.runArchivePass(); } catch (e) { archive = { archived: 0, details: [], error: e.message }; }
  } else if (!evolver) {
    archive = { archived: 0, details: [], error: 'skill-evolver 不可用' };
  }

  const optimize = runOptimizePass(Object.assign({}, o, { evolver: evolver }));

  // 元技能自动固化（Level 3：无人干预地"改进改进方法本身"）
  let metaApplied = { applied: false, reason: '未执行' };
  try {
    const meta = require('./meta-evolve');
    if (meta && typeof meta.autoApplySuggestions === 'function') {
      metaApplied = meta.autoApplySuggestions({});
    }
  } catch (e) { metaApplied = { applied: false, reason: e.message }; }

  return {
    ranAt: new Date().toISOString(),
    archived: (archive && typeof archive.archived === 'number') ? archive.archived : 0,
    archive: archive,
    optimize: optimize,
    optimizeCount: optimize.total,
    metaApplied: metaApplied,
  };
}

// ========== 定时器 ==========

let schedulerTimer = null;

/**
 * 启动每日维护定时器（默认 24 小时）。
 * @param {object} [opts]
 *   - intervalMs：间隔毫秒（默认 CONFIG.intervalMs）
 *   - run：自定义执行函数（默认 runDailyMaintenance）
 *   - 其余参数透传给 runDailyMaintenance
 * @returns {{started:boolean, intervalMs?:number, reason?:string}}
 */
function startScheduler(opts) {
  const o = opts || {};
  // 总开关关 → 不启动
  if (!isEvolutionEnabled()) {
    return { started: false, reason: '自进化飞轮总开关关闭' };
  }
  if (schedulerTimer) return { started: false, reason: '定时器已在运行' };
  const intervalMs = (typeof o.intervalMs === 'number' && o.intervalMs > 0) ? o.intervalMs : CONFIG.intervalMs;
  const run = typeof o.run === 'function' ? o.run : function () { return runDailyMaintenance(o); };
  try {
    schedulerTimer = setInterval(function () {
      // 总开关关 → 本次不跑（运行时切换即时生效）
      if (!isEvolutionEnabled()) return;
      try { run(); } catch (e) { /* 静默 */ }
    }, intervalMs);
    if (schedulerTimer.unref) schedulerTimer.unref();
    return { started: true, intervalMs: intervalMs };
  } catch (e) {
    schedulerTimer = null;
    return { started: false, reason: e.message };
  }
}

/** 停止定时器 */
function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    return { stopped: true };
  }
  return { stopped: false };
}

/** 定时器是否在运行 */
function isSchedulerRunning() {
  return !!schedulerTimer;
}

module.exports = {
  CONFIG,
  isEvolutionEnabled,
  summarizeTrace,
  shouldAutoRetrospect,
  triggerRetrospect,
  buildAdvice,
  runOptimizePass,
  runDailyMaintenance,
  startScheduler,
  stopScheduler,
  isSchedulerRunning,
};
