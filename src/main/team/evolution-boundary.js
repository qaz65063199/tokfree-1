'use strict';

/**
 * 进化边界管理（EvolutionBoundary）—— 给自工程化系统装上「护栏」
 *
 * 解决的问题：自工程化飞轮（trace → retrospect → skill-forge → skill-evolver → meta-evolve）
 * 会持续生成技能、迭代技能、递归改进「改进方法」本身，若无约束会出现：
 *   1. 技能库无限膨胀 → 低质技能淹没高质技能，提示词注入爆炸
 *   2. 元技能递归无深度限制 → 「优化优化优化」失控
 *   3. 进化停滞却无人察觉 → 飞轮空转
 *   4. 达标后仍不停机 → 浪费算力（用户要的是「直到完美」，达标即完美应停）
 *
 * 本模块提供 5 个纯函数式检查（全部容错，失败静默降级）：
 *   - checkSkillCapacity   技能库容量边界
 *   - checkMetaDepth       元技能递归深度限制
 *   - isPerfect            「完美」判定（可提前停机）
 *   - detectEvolutionStall 进化停滞检测
 *   - getCapacityReport    容量/健康度汇总
 *
 * 设计原则：纯 Node 模块，仅惰性依赖 electron / knowledge / skill-evolver / meta-evolve / trace，
 * 任何异常都静默降级返回保守结果，绝不抛出、绝不改变现有行为。
 */

// ========== 配置 ==========

const CONFIG = {
  // 技能库容量上限：超过建议先淘汰再新增
  maxSkills: 100,
  // 元技能版本号上限：超过告警，防递归失控
  maxMetaVersion: 50,
  // 「完美」判定：需连续 N 轮保持满分
  perfectStreak: 2,
  // 进化停滞：超过 N 天无新增技能 / 无元技能改进 → 判定停滞
  stallDays: 14,
  // 轨迹容量参考上限（与 trace.MAX_TRACES 对齐）
  maxTraces: 100,
};

// ========== 惰性依赖 ==========

/** 惰性加载 skill-evolver（可注入，测试用） */
function loadEvolver(opts) {
  if (opts && opts.evolver) return opts.evolver;
  return require('./skill-evolver');
}

/** 惰性加载 meta-evolve（可注入） */
function loadMeta(opts) {
  if (opts && opts.meta) return opts.meta;
  return require('./meta-evolve');
}

/** 惰性加载 knowledge（可注入） */
function loadKnowledge(opts) {
  if (opts && opts.knowledge) return opts.knowledge;
  return require('../knowledge');
}

/** 惰性加载 trace（可注入） */
function loadTrace(opts) {
  if (opts && opts.trace) return opts.trace;
  return require('./trace');
}

function num(v, d) {
  return (typeof v === 'number' && isFinite(v)) ? v : d;
}

// ========== 1. 技能库容量边界 ==========

/**
 * 检查技能库是否已达/超容量上限。
 * @param {object} [opts]
 *   - limit：容量上限（默认 CONFIG.maxSkills）
 *   - skills：注入的技能数组（测试用，优先于 knowledge）
 *   - knowledge：注入的 knowledge 模块
 * @returns {{ count:number, limit:number, atLimit:boolean, remaining:number, suggestion:string }}
 */
function checkSkillCapacity(opts) {
  const o = opts || {};
  const limit = num(o.limit, CONFIG.maxSkills);

  let count = 0;
  try {
    if (Array.isArray(o.skills)) {
      count = o.skills.length;
    } else {
      const knowledge = loadKnowledge(o);
      const list = knowledge.listSkills();
      count = Array.isArray(list) ? list.length : 0;
    }
  } catch (e) {
    // 读取失败：保守返回未达上限（不阻断正常新增）
    return { count: 0, limit: limit, atLimit: false, remaining: limit, suggestion: '无法读取技能库，跳过容量检查。' };
  }

  const atLimit = count >= limit;
  const remaining = Math.max(0, limit - count);
  return {
    count: count,
    limit: limit,
    atLimit: atLimit,
    remaining: remaining,
    suggestion: atLimit
      ? '技能库已达上限（' + count + '/' + limit + '），请先运行淘汰（skill-evolver.runArchivePass / auto_skill_archive_pass）腾出空间，再新增技能。'
      : '技能库容量正常（' + count + '/' + limit + '），可继续新增。',
  };
}

// ========== 2. 元技能递归深度限制 ==========

/**
 * 检查元技能版本号是否超过递归深度上限。
 * 元技能每 bumpMetaVersion 一次版本 +1；版本无限增长意味着「优化优化优化」失控。
 * @param {object} [opts]
 *   - limit：版本上限（默认 CONFIG.maxMetaVersion）
 *   - version：注入的当前版本号（测试用，优先于 meta-evolve）
 *   - meta：注入的 meta-evolve 模块
 * @returns {{ version:number, limit:number, atLimit:boolean, warning:string|null }}
 */
function checkMetaDepth(opts) {
  const o = opts || {};
  const limit = num(o.limit, CONFIG.maxMetaVersion);

  let version = 1;
  try {
    if (typeof o.version === 'number') {
      version = o.version;
    } else {
      const meta = loadMeta(o);
      const cur = meta.getMetaVersion();
      version = num(cur && cur.version, 1);
    }
  } catch (e) {
    return { version: 1, limit: limit, atLimit: false, warning: null };
  }

  const atLimit = version >= limit;
  return {
    version: version,
    limit: limit,
    atLimit: atLimit,
    warning: atLimit
      ? '元技能版本已达 ' + version + '（上限 ' + limit + '），递归改进过深。建议停止元层 bump，转向人工审视当前方法是否已收敛。'
      : null,
  };
}

// ========== 3. 「完美」判定（关键：可提前停机） ==========

/**
 * 判定目标是否已「完美」——达标 + 连续 N 轮满分 + 无未解决问题。
 * 用于「直到完美达到人类设定目标」场景：完美即停机，不必跑满 maxRounds。
 *
 * @param {object} goal self-loop 目标对象（含 successCriteria / history）
 * @param {object} [evidence]
 *   - criteriaResults：{ [criterion]: boolean } 本轮各标准是否满足
 *   - aiScore：0-1（无显式标准时以 aiScore>=1 判定）
 *   - unresolved：未解决问题数组（非空视为不完美）
 *   - streak：要求的连续满分轮数（默认 CONFIG.perfectStreak）
 * @returns {{ perfect:boolean, reason:string }}
 */
function isPerfect(goal, evidence) {
  try {
    const g = goal || {};
    const ev = evidence || {};
    const streakNeed = num(ev.streak, CONFIG.perfectStreak);
    const crit = Array.isArray(g.successCriteria) ? g.successCriteria : [];

    // 3.1 所有 successCriteria 满足
    let allPassed;
    let criteriaDetail;
    if (crit.length === 0) {
      const score = num(ev.aiScore, 0);
      allPassed = score >= 1;
      criteriaDetail = allPassed ? '无显式标准，aiScore 满分' : '无显式标准且 aiScore 未满分(' + score + ')';
    } else {
      const results = ev.criteriaResults || {};
      const failed = crit.filter(function (c) { return results[c] !== true; });
      allPassed = failed.length === 0;
      criteriaDetail = allPassed
        ? '全部 ' + crit.length + ' 条标准满足'
        : '未达标标准：' + failed.join('、');
    }

    // 3.2 无未解决问题
    const unresolved = Array.isArray(ev.unresolved) ? ev.unresolved.filter(function (x) { return x !== null && x !== undefined && x !== ''; }) : [];
    const noUnresolved = unresolved.length === 0;

    // 3.3 连续 N 轮保持满分（goal.history 尾部）
    const history = Array.isArray(g.history) ? g.history : [];
    let streak = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i] || {};
      if (num(h.score, 0) >= 1) streak++;
      else break;
    }
    // 当前轮是否已计入 history（self-loop 先 push 再判定 → 传 currentCounted=true，避免重复计数）
    const currentFull = allPassed ? 1 : 0;
    const effectiveStreak = ev.currentCounted ? streak : (currentFull + streak);
    const streakOk = effectiveStreak >= streakNeed;

    const perfect = allPassed && noUnresolved && streakOk;

    const reasons = [];
    reasons.push(criteriaDetail);
    reasons.push(noUnresolved ? '无未解决问题' : '存在未解决问题(' + unresolved.length + '项)');
    reasons.push('连续满分 ' + effectiveStreak + '/' + streakNeed + ' 轮');

    return {
      perfect: perfect,
      reason: (perfect ? '已达完美：' : '未达完美：') + reasons.join('；'),
    };
  } catch (e) {
    return { perfect: false, reason: '判定异常，保守视为未完美：' + e.message };
  }
}

// ========== 4. 进化停滞检测 ==========

/**
 * 检测进化是否停滞：近期既无新技能生成，也无元技能改进。
 * @param {object} [opts]
 *   - now：当前时间戳（测试用，默认 Date.now()）
 *   - stallDays：停滞判定天数（默认 CONFIG.stallDays）
 *   - stats：注入的技能统计数组（测试用）
 *   - metaHistory：注入的元技能历史数组（测试用）
 *   - evolver / meta：注入模块
 * @returns {{ stalled:boolean, daysSince:number|null, lastActivityAt:number|null, action:string }}
 */
function detectEvolutionStall(opts) {
  const o = opts || {};
  const now = num(o.now, Date.now());
  const stallDays = num(o.stallDays, CONFIG.stallDays);

  let stats = o.stats;
  if (!Array.isArray(stats)) {
    try {
      stats = loadEvolver(o).listStats();
    } catch (e) { stats = []; }
  }

  let metaHistory = o.metaHistory;
  if (!Array.isArray(metaHistory)) {
    try {
      metaHistory = loadMeta(o).getMetaHistory();
    } catch (e) { metaHistory = []; }
  }

  // 收集所有活动时间点：技能创建 / 使用 / 元技能 bump
  const times = [];
  for (const s of (Array.isArray(stats) ? stats : [])) {
    if (!s) continue;
    if (typeof s.createdAt === 'number') times.push(s.createdAt);
    if (typeof s.lastUsedAt === 'number') times.push(s.lastUsedAt);
  }
  for (const h of (Array.isArray(metaHistory) ? metaHistory : [])) {
    if (!h) continue;
    if (h.at) {
      const t = Date.parse(h.at);
      if (isFinite(t)) times.push(t);
    }
  }

  if (times.length === 0) {
    return {
      stalled: false,
      daysSince: null,
      lastActivityAt: null,
      action: '无足够活动数据，暂不判定停滞。',
    };
  }

  const lastActivityAt = Math.max.apply(null, times);
  const daysSince = (now - lastActivityAt) / 86400000;
  const stalled = daysSince >= stallDays;

  return {
    stalled: stalled,
    daysSince: Math.round(daysSince * 10) / 10,
    lastActivityAt: lastActivityAt,
    action: stalled
      ? '进化已停滞 ' + Math.round(daysSince) + ' 天（超过 ' + stallDays + ' 天）。建议：auto_trace_list → auto_retrospect 复盘近期任务 → auto_skill_forge 生成/优化技能，重启进化飞轮。'
      : '进化活跃（最近活动 ' + Math.round(daysSince * 10) / 10 + ' 天前），无需干预。',
  };
}

// ========== 5. 容量报告 ==========

/**
 * 汇总技能库 / 元技能 / 轨迹的容量与健康度。
 * @param {object} [opts] 同各子检查的注入参数
 * @returns {{ skills:object, meta:object, traces:object, health:string, generatedAt:string }}
 */
function getCapacityReport(opts) {
  const o = opts || {};

  const skills = checkSkillCapacity(o);
  const meta = checkMetaDepth(o);

  // 轨迹计数（容错：trace 模块不可用则跳过）
  let traceCount = 0;
  let traceLimit = CONFIG.maxTraces;
  try {
    const traceMod = loadTrace(o);
    if (typeof traceMod.listTraces === 'function') {
      const list = traceMod.listTraces();
      traceCount = Array.isArray(list) ? list.length : 0;
    }
  } catch (e) { traceCount = 0; }

  const traces = {
    count: traceCount,
    limit: traceLimit,
    atLimit: traceCount >= traceLimit,
  };

  // 健康度：任一超限 → 'over'；接近上限（>=80%）→ 'warn'；否则 'ok'
  let health = 'ok';
  const ratio = function (c, l) { return l > 0 ? c / l : 0; };
  if (skills.atLimit || meta.atLimit || traces.atLimit) health = 'over';
  else if (ratio(skills.count, skills.limit) >= 0.8 || ratio(traces.count, traces.limit) >= 0.8) health = 'warn';

  return {
    skills: skills,
    meta: meta,
    traces: traces,
    health: health,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  CONFIG,
  checkSkillCapacity,
  checkMetaDepth,
  isPerfect,
  detectEvolutionStall,
  getCapacityReport,
};
