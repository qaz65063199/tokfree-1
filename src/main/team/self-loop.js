/**
 * 自驱循环引擎（Self-Driven Loop）—— 无人干预的持续进化闭环
 *
 * 解决的问题：现有自工程化零件（trace/retrospect/skill-forge/skill-evolver/meta-evolve）
 * 都需外部"喊一声"才动。本模块把飞轮接上"传送带"：
 *
 *   人类设定目标 → 循环：
 *     [执行] → [评估是否达标] → 未达标 → [复盘找问题] → [自己出测试题] → [生成/优化技能]
 *       ↑                                                              ↓
 *       └───────────────── 再执行（用新技能） ←───────────────────────┘
 *   直到 [达标] 或 [达到最大轮次/时间上限]。
 *
 * 关键能力（对应"无人干预"）：
 *   1. 目标管理：createGoal（人类设一次）→ 循环自己追
 *   2. 达标判定：evaluateGoal（规则 + 可选 AI 评分）
 *   3. 自出题：generateTestCases（自己给自己出测试案例）
 *   4. 自循环：tick 被调度器定期驱动，自动推进
 *   5. 停止条件：达标 / 达到 maxRounds / 达到 deadline / 用户中止
 *
 * 纯状态 + 决策模块：不直接执行 AI（执行由上层调度器/窗口完成）。
 */
const fs = require('fs');
const path = require('path');
const { getBaseDir } = require('../../core/agent-runtime/paths');

const MAX_ROUNDS_DEFAULT = 20;
const MAX_MS_DEFAULT = 6 * 60 * 60 * 1000; // 6 小时

// ========== 存储 ==========
let FILE = null;
function getFile() {
  if (!FILE) {
    const dir = path.join(getBaseDir(), 'self-loop');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    FILE = path.join(dir, 'goals.json');
  }
  return FILE;
}

let cache = null;
function load() {
  if (cache) return cache;
  try {
    const f = getFile();
    if (fs.existsSync(f)) {
      const obj = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (obj && Array.isArray(obj.goals)) { cache = obj; return cache; }
    }
  } catch (e) {}
  cache = { goals: [] };
  return cache;
}
function save() {
  try {
    fs.writeFileSync(getFile(), JSON.stringify(cache, null, 2), 'utf-8');
    return true;
  } catch (e) { return false; }
}

// ========== 目标 ==========

/**
 * 创建目标（人类设定一次，循环自己追）
 * @param {object} opts
 *   - title 目标标题（必填）
 *   - successCriteria 达标标准（数组，每条一个可验证的条件）
 *   - maxRounds 最大轮次（默认 20）
 *   - maxMs 最长运行毫秒（默认 6 小时）
 *   - profileId 执行窗口（可选）
 *   - testQueries 测试查询（可选，供技能触发验证）
 */
function createGoal(opts) {
  const o = opts || {};
  if (!o.title) return { success: false, error: '缺少 title' };
  const goal = {
    id: 'goal-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    title: String(o.title),
    successCriteria: Array.isArray(o.successCriteria) ? o.successCriteria.slice() : [],
    maxRounds: typeof o.maxRounds === 'number' ? o.maxRounds : MAX_ROUNDS_DEFAULT,
    maxMs: typeof o.maxMs === 'number' ? o.maxMs : MAX_MS_DEFAULT,
    profileId: o.profileId || '',
    projectDir: o.projectDir || '',   // 归属项目目录（空串=无归属，向后兼容老数据）
    testQueries: Array.isArray(o.testQueries) ? o.testQueries.slice() : [],
    requirePerfect: o.perfect === true,  // 是否要求"完美"（连续N轮满分）才停
    status: 'running',      // running | achieved | perfect | exhausted | aborted
    round: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    history: [],            // 每轮记录
    bestScore: 0,
    note: o.note || '',
  };
  const db = load();
  db.goals.push(goal);
  save();
  return { success: true, goal: goal };
}

function getGoal(id) {
  const db = load();
  return db.goals.find(function (g) { return g.id === id; }) || null;
}

function listGoals(filter) {
  const db = load();
  let arr = db.goals.slice();
  if (filter && filter.status) arr = arr.filter(function (g) { return g.status === filter.status; });
  // 按窗口过滤：只返回「该窗口的目标」+「无归属（profileId 为空）的全局目标」。
  // 绝不返回其他窗口（不同 profileId）的目标，避免跨窗口污染。向后兼容：不传 profileId 时不按窗口过滤。
  if (filter && filter.profileId) {
    const pid = filter.profileId;
    arr = arr.filter(function (g) { return !g.profileId || g.profileId === pid; });
  }
  // 按项目【严格】过滤：只返回「本项目（projectDir 严格匹配）」+「显式全局（global===true）」的目标。
  // 绝不返回其他项目，也【不再】把无归属老数据当作本项目目标（那是历史跨项目污染源）。
  // 向后兼容：不传 projectDir 时不按项目过滤（返回全部）。
  if (filter && filter.projectDir) {
    const dir = filter.projectDir;
    arr = arr.filter(function (g) { return g.projectDir === dir || g.global === true; });
  }
  return arr.sort(function (a, b) { return b.createdAt - a.createdAt; });
}

/**
 * 当前活跃（running）的目标
 * @param {string} [projectDir] 可选；传则只返回「该项目 + 无归属」的 running 目标（向后兼容：不传=全部）
 */
function listRunningGoals(projectDir) {
  const f = { status: 'running' };
  if (projectDir) f.projectDir = projectDir;
  return listGoals(f);
}

/**
 * 评估是否达标（规则版；上层可传 aiScore 增强）
 * @param {object} goal
 * @param {object} evidence { criteriaResults?: {[criterion]:boolean}, aiScore?: number, summary?: string }
 * @returns {{ achieved: boolean, score: number, detail: string }}
 */
function evaluateGoal(goal, evidence) {
  const g = goal || {};
  const ev = evidence || {};
  const crit = Array.isArray(g.successCriteria) ? g.successCriteria : [];
  if (crit.length === 0) {
    // 无显式标准：用 aiScore（0-1）或默认未达标
    const score = typeof ev.aiScore === 'number' ? ev.aiScore : 0;
    return { achieved: score >= 1, score: score, detail: '无显式标准，以 aiScore 判定' };
  }
  const results = ev.criteriaResults || {};
  let passed = 0;
  const details = [];
  for (const c of crit) {
    const ok = results[c] === true;
    if (ok) passed++;
    details.push((ok ? '✓' : '✗') + ' ' + c);
  }
  const score = crit.length ? passed / crit.length : 0;
  return {
    achieved: passed === crit.length,
    score: score,
    detail: passed + '/' + crit.length + ' 达标：' + details.join('；'),
  };
}

/**
 * 记录一轮（执行结果 + 评估 + 本轮做了什么改进）
 */
function recordRound(goalId, roundData) {
  const g = getGoal(goalId);
  if (!g) return { success: false, error: '目标不存在' };
  const rd = roundData || {};
  g.round = (g.round || 0) + 1;
  const ev = evaluateGoal(g, rd.evidence || {});
  g.bestScore = Math.max(g.bestScore || 0, ev.score || 0);
  g.history.push({
    round: g.round,
    ts: Date.now(),
    score: ev.score,
    achieved: ev.achieved,
    detail: ev.detail,
    actions: rd.actions || [],     // 本轮做了什么（复盘/生成技能等）
    traceIds: rd.traceIds || [],
    note: rd.note || '',
  });
  g.updatedAt = Date.now();

  // 「完美」判定（仅当目标开启 requirePerfect 时；更严格：连续 N 轮满分 + 无未解决问题）
  if (g.requirePerfect) try {
    const boundary = require('./evolution-boundary');
    const perfectRes = boundary.isPerfect(g, {
      criteriaResults: (rd.evidence && rd.evidence.criteriaResults) || {},
      aiScore: rd.evidence && rd.evidence.aiScore,
      unresolved: rd.unresolved,
      currentCounted: true, // 本轮已 push 进 history，避免重复计数
    });
    g.lastPerfectCheck = perfectRes;
    if (perfectRes && perfectRes.perfect) {
      g.status = 'perfect';
      g.perfectReason = perfectRes.reason;
      save();
      return { success: true, goal: g, evaluation: ev, perfect: true, perfectReason: perfectRes.reason };
    }
  } catch (_) {
    // boundary 不可用时降级：忽略完美判定
  }

  // 判定状态
  if (ev.achieved) {
    // 完美模式：达标但未达完美 → 继续跑（不停）
    g.status = g.requirePerfect ? 'running' : 'achieved';
  } else if (g.round >= g.maxRounds) {
    g.status = 'exhausted';
  } else if (Date.now() - g.createdAt >= g.maxMs) {
    g.status = 'exhausted';
  }
  save();
  return { success: true, goal: g, evaluation: ev };
}

/** 中止目标 */
function abortGoal(goalId, reason) {
  const g = getGoal(goalId);
  if (!g) return { success: false, error: '目标不存在' };
  g.status = 'aborted';
  g.note = reason || '用户中止';
  g.updatedAt = Date.now();
  save();
  return { success: true, goal: g };
}

// ========== 自己出题 ==========

/**
 * 为一个"待改进点"生成测试案例（自己给自己出题）
 * @param {object} finding 复盘发现 {type, title, detail, suggestion}
 * @param {object} [opts]
 * @returns {{ question: string, expect: string, how: string }}
 */
function generateTestCase(finding, opts) {
  const f = finding || {};
  const type = f.type || 'general';
  if (type === 'failure') {
    return {
      question: '当 ' + (f.title || '该操作') + ' 失败时，系统应如何处理？',
      expect: '不崩溃、给出明确错误、按降级策略重试或跳过',
      how: '构造一个会触发「' + (f.detail || '该错误') + '」的场景，执行并观察',
    };
  }
  if (type === 'hotspot') {
    return {
      question: '如何把「' + (f.title || '该步骤') + '」的耗时降下来？',
      expect: '耗时下降 30% 以上，且结果不变',
      how: '复现该步骤，优化后对比耗时',
    };
  }
  if (type === 'retry') {
    return {
      question: '如何避免「' + (f.title || '重复调用') + '」？',
      expect: '相同操作只执行一次',
      how: '构造同类输入，观察是否还重复',
    };
  }
  return {
    question: '针对「' + (f.title || '改进点') + '」，优化后能否通过原验收？',
    expect: '原功能不回归 + 改进点达标',
    how: '重跑原任务 + 专项检查',
  };
}

/**
 * 为技能草稿生成触发测试查询（正例 + 负例）
 */
function generateTestQueries(draft) {
  const d = draft || {};
  const desc = String(d.description || d.name || '');
  const words = desc.split(/[\s,.。，、]+/).filter(function (w) { return w.length >= 2; });
  const positive = [
    words.slice(0, 4).join(' ') || d.name || '目标任务',
    desc.split(/[.。]/)[0] || desc,
  ].filter(Boolean);
  const negative = ['写一首诗', '查询天气', '翻译一段文字'];
  return { positive: positive, negative: negative };
}

// ========== 供调度器调用的"下一轮该做什么" ==========

/**
 * 决定目标的下一步动作（供自驱调度器消费）
 * @returns {{ action: string, payload: object } | null}
 *   action: 'execute'（去执行）| 'retrospect'（复盘）| 'forge'（生成技能）
 *         | 'optimize'（优化）| 'done'（无需动作）
 */
function decideNextAction(goalId) {
  const g = getGoal(goalId);
  if (!g) return { action: 'none', payload: {} };
  if (g.status !== 'running') return { action: 'done', payload: { status: g.status, reason: g.perfectReason || '' } };

  const last = g.history[g.history.length - 1];
  // 第一轮：先执行
  if (!last) {
    return { action: 'execute', payload: { goalId: g.id, title: g.title, round: 1 } };
  }
  // 上一轮没达标：先复盘 → 生成/优化 → 再执行
  if (!last.achieved) {
    // 若上一轮已复盘但没生成技能 → 生成；否则复盘
    const actions = last.actions || [];
    const didRetrospect = actions.indexOf('retrospect') !== -1;
    const didForge = actions.indexOf('forge') !== -1 || actions.indexOf('optimize') !== -1;
    if (!didRetrospect) {
      return { action: 'retrospect', payload: { goalId: g.id, round: g.round + 1, traceIds: last.traceIds || [] } };
    }
    if (!didForge) {
      return { action: 'forge', payload: { goalId: g.id, round: g.round + 1 } };
    }
    // 复盘+生成都做了 → 再执行（用新技能）
    return { action: 'execute', payload: { goalId: g.id, title: g.title, round: g.round + 1 } };
  }
  return { action: 'done', payload: { status: 'achieved' } };
}

/** 生成"给 AI 的下一轮指令"（自然语言） */
function buildNextRoundPrompt(goalId) {
  const g = getGoal(goalId);
  if (!g) return '';
  const d = decideNextAction(goalId);
  const NL = String.fromCharCode(10);
  const lines = [];
  lines.push('【自驱循环 · 第 ' + (g.round + 1) + ' 轮】目标：' + g.title);
  lines.push('达标标准：' + (g.successCriteria.length ? g.successCriteria.join('；') : '(无显式标准)'));
  lines.push('当前进度：第 ' + g.round + ' 轮，历史最高分 ' + Math.round((g.bestScore || 0) * 100) + '%');
  lines.push('');
  if (d.action === 'execute') {
    lines.push('## 你的任务');
    lines.push('⚠️ 请先 skill_read(\'evolution-flywheel\') 并按其 SOP 执行；只针对本项目。');
    lines.push('请执行/推进以下目标，直到满足达标标准：');
    lines.push('**' + g.title + '**');
    if (g.note) lines.push('补充说明：' + g.note);
    lines.push('');
    lines.push('完成后：');
    lines.push('1. 用 auto_trace_list(5) 找到本次执行轨迹；');
    lines.push('2. 用 auto_goal_round(goalId, criteriaResults) 记录本轮（对照每条达标标准填 true/false）；');
    lines.push('3. 若未达标，循环会自动让你复盘+生成技能，然后继续。');
    lines.push('');
    lines.push('goalId = ' + g.id);
  } else if (d.action === 'retrospect') {
    lines.push('上一轮未达标。请：');
    lines.push('1. auto_trace_list 找到最近轨迹 → auto_retrospect(taskId) 复盘；');
    lines.push('2. 从复盘中找出可复用的改进点；');
    lines.push('3. 若发现可复用流程，用 auto_skill_forge 生成技能并 auto_skill_forge_commit 入库。');
    lines.push('4. 然后重新执行目标，看是否比上一轮更好。');
  } else if (d.action === 'forge') {
    lines.push('请基于上一轮复盘，生成/优化技能并入库，然后重新执行目标。');
  }
  lines.push('');
  lines.push('⚠️ 无人干预模式：请自主推进，不要停下等人。只有真正达标（' +
    (g.successCriteria.length ? '所有标准满足' : '目标完成') + '）才停止。');
  return lines.join(NL);
}

// ========== 单窗口兜底：从轨迹自动推断本轮 ==========

/**
 * 从最近轨迹自动推断本轮（当 AI 忘记调 auto_goal_round 时）
 *
 * 解决痛点：单窗口模式下，AI 执行完可能忘了记录本轮 → round 不变 →
 * 驱动器重复注入同一轮（直到防呆层注入上限）。
 *
 * 逻辑：找"上次更新之后"产生的轨迹，按 outcome 保守推断进度分（不判达标，
 * 因为无法知道用户各条达标标准是否满足），记录一轮并标注 [自动推断]。
 * 连续低分会被防呆层识别为停滞 → 熔断（提醒用户）。
 *
 * @param {string} goalId
 * @returns {{ inferred:boolean, traceId?:string, outcome?:string, score?:number, goal?:object }}
 */
function inferRoundFromTrace(goalId) {
  try {
    const g = getGoal(goalId);
    if (!g || g.status !== 'running') return { inferred: false };
    let trace;
    try { trace = require('./trace'); } catch (_) { return { inferred: false }; }
    let traces;
    try { traces = trace.listTraces(10); } catch (_) { return { inferred: false }; }
    if (!traces || traces.length === 0) return { inferred: false };

    const since = g.updatedAt || g.createdAt || 0;
    const cand = traces.find(function (t) {
      const ts = Date.parse(t.startedAt || t.endedAt || 0) || 0;
      if (ts < since) return false;
      if (g.profileId && t.profileId && t.profileId !== g.profileId) return false;
      return true;
    });
    if (!cand) return { inferred: false };

    const outcome = cand.outcome || 'empty';
    let score = 0;
    if (outcome === 'success') score = 0.6;
    else if (outcome === 'partial') score = 0.4;
    else score = 0.1;

    const res = recordRound(goalId, {
      evidence: { aiScore: score },
      actions: ['auto-infer'],
      traceIds: [cand.taskId],
      note: '[自动推断] AI 未主动记录本轮，系统据轨迹(' + outcome + ', ' +
        (cand.stepCount || 0) + '步/' + (cand.errorCount || 0) + '错)推断',
    });
    return { inferred: true, traceId: cand.taskId, outcome: outcome, score: score, goal: res && res.goal };
  } catch (e) {
    return { inferred: false };
  }
}

// ========== 老数据迁移 ==========

/**
 * 迁移历史遗留目标（幂等）：把「没有 projectDir 字段」的老数据标记为 legacy:true，
 * 并补上 projectDir:''（使其不再匹配任何项目），避免继续污染战略巡检简报。
 *
 * 策略（保守，不丢数据）：
 *   - 不删除、不移动文件，只在原记录上打 legacy 标记 + 补空 projectDir；
 *   - legacy 目标因 projectDir==='' 且无 global:true，天然被严格过滤排除；
 *   - 幂等：已有 projectDir 字段的记录不再改动，重复调用 migrated 恒为 0（首次之后）。
 * @returns {{ migrated:number, total:number, legacyTotal:number }}
 */
function migrateLegacyGoals() {
  const db = load();
  const goals = Array.isArray(db.goals) ? db.goals : (db.goals = []);
  let migrated = 0;
  let legacyTotal = 0;
  for (let i = 0; i < goals.length; i++) {
    const g = goals[i];
    if (!g || typeof g !== 'object') continue;
    if (typeof g.projectDir === 'undefined') {
      // 老数据：无 projectDir 字段
      if (g.legacy !== true) { g.legacy = true; migrated++; }
      g.projectDir = '';   // 补空串 → 不再匹配任何项目（不丢数据）
    }
    if (g.legacy === true) legacyTotal++;
  }
  if (migrated > 0) save();
  return { migrated: migrated, total: goals.length, legacyTotal: legacyTotal };
}

// ========== 调试/测试 ==========
function _reset() { cache = { goals: [] }; save(); }

module.exports = {
  createGoal,
  getGoal,
  listGoals,
  listRunningGoals,
  evaluateGoal,
  recordRound,
  abortGoal,
  generateTestCase,
  generateTestQueries,
  decideNextAction,
  buildNextRoundPrompt,
  inferRoundFromTrace,
  migrateLegacyGoals,
  _reset,
  MAX_ROUNDS_DEFAULT,
  MAX_MS_DEFAULT,
};
