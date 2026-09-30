/**
 * 自驱循环防呆层（Self-Loop Guard）—— 让无人干预循环不会失控
 *
 * 解决的问题：自驱循环（self-loop.js + self-loop-driver.js）无人干预持续运行，
 * 一旦判定失误/环境异常，可能失控：死循环、烧钱、注入风暴、停滞空转。
 * 本模块提供"外部刹车"，在驱动器注入下一轮前先做健康检查：
 *
 *   驱动器 tick → guard.checkGoalHealth(goalId) → healthy?
 *     ├─ healthy       → 继续注入
 *     ├─ circuit-break → 熔断（换策略/停止并通知）
 *     └─ stop          → 停止（超预算/超注入上限）
 *
 * 五道防护：
 *   1. 死循环防护：注入次数上限 + 同一步骤重复检测
 *   2. 成本控制：轮次/时长/token 估算与预算判定
 *   3. 注入风暴防护：全局注入频率限制（每分钟最多 N 次）
 *   4. 停滞检测 + 熔断：连续 N 轮无提升 / 连续异常 → 熔断
 *   5. 异常自愈建议：suggestRecovery 给出降级/换策略/停止通知
 *
 * 纯 Node 模块，存储路径经 agent-runtime paths 注入（经 self-loop.js）+ self-loop.js。
 * 所有导出函数返回结构化结果，绝不抛异常（失败静默降级）。
 */
const selfLoop = require('./self-loop');

// ========== 常量（可被 config 覆盖） ==========
const MAX_INJECTS_PER_GOAL = 50;                 // 同一目标注入次数上限
const MAX_CONSECUTIVE_FAULTS = 3;                // 连续异常熔断阈值
const STAGNATION_THRESHOLD = 3;                  // 连续 N 轮无提升 → 停滞
const REPEAT_THRESHOLD = 3;                      // 同一步骤连续重复 N 轮 → 熔断
const INJECT_WINDOW_MS = 60 * 1000;              // 注入频率窗口：1 分钟
const INJECT_MAX_PER_WINDOW = 2;                 // 窗口内最多注入 2 次
const AVG_TOKENS_PER_ROUND = 8000;               // 每轮粗略 token 估算

const DEFAULT_BUDGET = {
  maxRounds: selfLoop.MAX_ROUNDS_DEFAULT || 20,
  maxMs: selfLoop.MAX_MS_DEFAULT || 6 * 60 * 60 * 1000,
  maxTokens: 500000,
};

// ========== 运行时状态（进程内，重启清零） ==========
const injectHistory = new Map();   // profileId -> [ts, ...]（仅保留窗口内）
const goalInjectCount = new Map(); // goalId -> 累计注入次数
const faultState = new Map();      // goalId -> { count, lastReason }

// ========== 成本控制 ==========

/**
 * 估算目标已消耗（轮次、时长、粗略 token）
 * @param {object} goal
 * @returns {{ rounds:number, elapsedMs:number, elapsedHours:number, tokens:number }}
 */
function estimateCost(goal) {
  try {
    const g = goal || {};
    const rounds = typeof g.round === 'number' ? g.round : 0;
    const createdAt = typeof g.createdAt === 'number' ? g.createdAt : Date.now();
    const elapsedMs = Math.max(0, Date.now() - createdAt);
    const tokens = rounds * AVG_TOKENS_PER_ROUND;
    return {
      rounds: rounds,
      elapsedMs: elapsedMs,
      elapsedHours: Number((elapsedMs / 3600000).toFixed(2)),
      tokens: tokens,
    };
  } catch (e) {
    return { rounds: 0, elapsedMs: 0, elapsedHours: 0, tokens: 0 };
  }
}

/** 合并 budget：config 优先，其次 goal 自带，最后默认 */
function resolveBudget(goal, config) {
  const g = goal || {};
  const c = config || {};
  function pick(key) {
    if (typeof c[key] === 'number') return c[key];
    if (typeof g[key] === 'number') return g[key];
    return DEFAULT_BUDGET[key];
  }
  return {
    maxRounds: pick('maxRounds'),
    maxMs: pick('maxMs'),
    maxTokens: pick('maxTokens'),
  };
}

/**
 * 检查是否超预算
 * @param {object} goal
 * @param {object} [config] { maxRounds, maxMs, maxTokens }
 * @returns {{ exceeded:boolean, reason:string, cost:object, budget:object }}
 */
function checkBudget(goal, config) {
  try {
    const budget = resolveBudget(goal, config);
    const cost = estimateCost(goal);
    if (cost.rounds >= budget.maxRounds) {
      return { exceeded: true, reason: '轮次超预算 (' + cost.rounds + '/' + budget.maxRounds + ')', cost: cost, budget: budget };
    }
    if (cost.elapsedMs >= budget.maxMs) {
      return { exceeded: true, reason: '时长超预算 (' + cost.elapsedHours + 'h/' + Number((budget.maxMs / 3600000).toFixed(2)) + 'h)', cost: cost, budget: budget };
    }
    if (cost.tokens >= budget.maxTokens) {
      return { exceeded: true, reason: 'token 估算超预算 (' + cost.tokens + '/' + budget.maxTokens + ')', cost: cost, budget: budget };
    }
    return { exceeded: false, reason: '', cost: cost, budget: budget };
  } catch (e) {
    return { exceeded: false, reason: '', error: e.message };
  }
}

// ========== 停滞检测 ==========

/**
 * 连续 N 轮得分无提升 → 判定停滞
 * @param {string} goalId
 * @returns {{ stagnant:boolean, consecutive:number, threshold:number, best:number, reason:string }}
 */
function detectStagnation(goalId) {
  try {
    const g = selfLoop.getGoal(goalId);
    const hist = g && Array.isArray(g.history) ? g.history : [];
    if (hist.length === 0) {
      return { stagnant: false, consecutive: 0, threshold: STAGNATION_THRESHOLD, best: 0, reason: '' };
    }
    let best = -1;
    let consecutive = 0;
    for (let i = 0; i < hist.length; i++) {
      const s = typeof hist[i].score === 'number' ? hist[i].score : 0;
      if (s > best) { best = s; consecutive = 0; }
      else { consecutive++; }
    }
    const stagnant = consecutive >= STAGNATION_THRESHOLD;
    return {
      stagnant: stagnant,
      consecutive: consecutive,
      threshold: STAGNATION_THRESHOLD,
      best: best,
      reason: stagnant ? ('连续 ' + consecutive + ' 轮得分无提升') : '',
    };
  } catch (e) {
    return { stagnant: false, consecutive: 0, threshold: STAGNATION_THRESHOLD, best: 0, reason: '' };
  }
}

/** 同一步骤（actions 签名 + 得分）连续重复检测 */
function detectRepeatedStep(goal) {
  try {
    const g = goal || {};
    const hist = Array.isArray(g.history) ? g.history : [];
    if (hist.length < REPEAT_THRESHOLD) return { repeated: false, count: hist.length, signature: '' };
    function sig(h) {
      const acts = Array.isArray(h && h.actions) ? h.actions.join(',') : '';
      const score = h && typeof h.score === 'number' ? h.score : 0;
      return acts + '|' + score;
    }
    const last = sig(hist[hist.length - 1]);
    let count = 0;
    for (let i = hist.length - 1; i >= 0 && sig(hist[i]) === last; i--) count++;
    return { repeated: count >= REPEAT_THRESHOLD, count: count, signature: last };
  } catch (e) {
    return { repeated: false, count: 0, signature: '' };
  }
}

// ========== 注入风暴防护 ==========

/**
 * 是否允许向该窗口注入（全局频率限制）
 * @param {string} profileId
 * @param {number} [now] 当前时间（测试可注入）
 * @returns {{ allowed:boolean, reason:string, remaining:number }}
 */
function canInject(profileId, now) {
  try {
    const t = typeof now === 'number' ? now : Date.now();
    const arr = (injectHistory.get(profileId) || []).filter(function (x) { return t - x < INJECT_WINDOW_MS; });
    if (arr.length >= INJECT_MAX_PER_WINDOW) {
      return { allowed: false, reason: '注入频率超限（' + INJECT_WINDOW_MS / 1000 + 's 内最多 ' + INJECT_MAX_PER_WINDOW + ' 次）', remaining: 0 };
    }
    return { allowed: true, reason: '', remaining: INJECT_MAX_PER_WINDOW - arr.length };
  } catch (e) {
    return { allowed: true, reason: '', remaining: INJECT_MAX_PER_WINDOW };
  }
}

/**
 * 记录一次注入（供频率统计 + 目标注入计数）
 * @param {string} profileId
 * @param {string} [goalId]
 * @param {number} [now]
 */
function recordInject(profileId, goalId, now) {
  try {
    const t = typeof now === 'number' ? now : Date.now();
    const arr = (injectHistory.get(profileId) || []).filter(function (x) { return t - x < INJECT_WINDOW_MS; });
    arr.push(t);
    injectHistory.set(profileId, arr);
    if (goalId) {
      goalInjectCount.set(goalId, (goalInjectCount.get(goalId) || 0) + 1);
    }
    return { success: true, count: goalId ? goalInjectCount.get(goalId) : 0 };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** 某目标的累计注入次数 */
function getInjectCount(goalId) {
  return goalInjectCount.get(goalId) || 0;
}

// ========== 异常追踪 ==========

/** 记录一次异常（连续异常 → 熔断） */
function recordFault(goalId, reason) {
  try {
    const s = faultState.get(goalId) || { count: 0, lastReason: '' };
    s.count += 1;
    s.lastReason = reason || '';
    faultState.set(goalId, s);
    return { count: s.count, lastReason: s.lastReason };
  } catch (e) {
    return { count: 0, lastReason: '' };
  }
}

/** 清除异常计数（成功一轮后调用） */
function clearFaults(goalId) {
  try { faultState.delete(goalId); return { success: true }; } catch (e) { return { success: false }; }
}

/** 读取异常状态 */
function getFaults(goalId) {
  return faultState.get(goalId) || { count: 0, lastReason: '' };
}

// ========== 健康度总检 ==========

/**
 * 检查目标健康度（汇总五道防护）
 * @param {string} goalId
 * @returns {{ healthy:boolean, issues:string[], action:'continue'|'circuit-break'|'stop', goalId:string, cost:object }}
 */
function checkGoalHealth(goalId) {
  try {
    const goal = selfLoop.getGoal(goalId);
    if (!goal) {
      return { healthy: false, issues: ['目标不存在'], action: 'stop', goalId: goalId, cost: null };
    }
    const issues = [];
    let action = 'continue';

    // 1. 预算
    const budget = checkBudget(goal);
    if (budget.exceeded) { issues.push(budget.reason); action = 'stop'; }

    // 2. 注入次数上限
    const injCount = getInjectCount(goalId);
    if (injCount >= MAX_INJECTS_PER_GOAL) {
      issues.push('注入次数超上限 (' + injCount + '/' + MAX_INJECTS_PER_GOAL + ')');
      action = 'stop';
    }

    // 3. 停滞
    const st = detectStagnation(goalId);
    if (st.stagnant) {
      issues.push(st.reason);
      if (action !== 'stop') action = 'circuit-break';
    }

    // 4. 同一步骤重复
    const rep = detectRepeatedStep(goal);
    if (rep.repeated) {
      issues.push('同一步骤连续重复 ' + rep.count + ' 轮（' + rep.signature + '）');
      if (action === 'continue') action = 'circuit-break';
    }

    // 5. 连续异常
    const f = getFaults(goalId);
    if (f.count >= MAX_CONSECUTIVE_FAULTS) {
      issues.push('连续异常 ' + f.count + ' 次' + (f.lastReason ? '：' + f.lastReason : ''));
      if (action !== 'stop') action = 'circuit-break';
    }

    return {
      healthy: issues.length === 0,
      issues: issues,
      action: action,
      goalId: goalId,
      cost: estimateCost(goal),
    };
  } catch (e) {
    return { healthy: false, issues: ['健康检查异常: ' + e.message], action: 'stop', goalId: goalId, cost: null };
  }
}

// ========== 异常自愈建议 ==========

/**
 * 根据问题给出恢复建议
 * @param {object} goal
 * @param {string[]} issues
 * @returns {{ strategy:'continue'|'degrade'|'switch-strategy'|'stop', actions:string[], notify:boolean, severity:string, issues:string[] }}
 */
function suggestRecovery(goal, issues) {
  try {
    const list = Array.isArray(issues) ? issues.slice() : [];
    const steps = [];
    let strategy = 'continue';
    let notify = false;
    let severity = 'info';

    const hasBudget = list.some(function (x) { return /轮次|时长|token|预算/.test(x); });
    const hasStagnation = list.some(function (x) { return /停滞|无提升|重复/.test(x); });
    const hasFault = list.some(function (x) { return /异常|失败|fault/i.test(x); });

    if (hasBudget) {
      strategy = 'stop';
      severity = 'high';
      notify = true;
      steps.push('停止循环：已达资源上限，向人类汇报进度与未达标原因');
      steps.push('保留已产出的技能/产物，等待人类调整目标或预算后重开');
    }
    if (hasStagnation) {
      if (strategy === 'continue') strategy = 'switch-strategy';
      if (severity === 'info') severity = 'medium';
      steps.push('换策略：跳过当前「复盘+生成」路径，改用不同方法重新执行');
      steps.push('降低目标粒度：把大目标拆成更小的可验证子目标');
    }
    if (hasFault) {
      if (strategy === 'continue') strategy = 'degrade';
      notify = true;
      if (severity === 'info') severity = 'medium';
      steps.push('降级运行：跳过高风险步骤，保留已验证的成功路径');
      steps.push('通知人类：连续异常，需人工确认环境/凭据后继续');
    }
    if (steps.length === 0) steps.push('保持当前策略继续推进');

    return {
      strategy: strategy,
      actions: steps,
      notify: notify,
      severity: severity,
      issues: list,
      title: goal && goal.title ? goal.title : '',
    };
  } catch (e) {
    return { strategy: 'continue', actions: [], notify: false, severity: 'info', issues: [], error: e.message };
  }
}

// ========== 调试/测试 ==========
function _reset() {
  injectHistory.clear();
  goalInjectCount.clear();
  faultState.clear();
}

module.exports = {
  // 死循环防护
  checkGoalHealth,
  detectRepeatedStep,
  // 成本控制
  estimateCost,
  checkBudget,
  resolveBudget,
  // 注入风暴防护
  canInject,
  recordInject,
  getInjectCount,
  // 停滞检测 + 熔断
  detectStagnation,
  recordFault,
  clearFaults,
  getFaults,
  // 异常自愈建议
  suggestRecovery,
  // 调试
  _reset,
  // 常量
  MAX_INJECTS_PER_GOAL,
  MAX_CONSECUTIVE_FAULTS,
  STAGNATION_THRESHOLD,
  REPEAT_THRESHOLD,
  INJECT_WINDOW_MS,
  INJECT_MAX_PER_WINDOW,
  DEFAULT_BUDGET,
};
