/**
 * 主大脑行为守卫（Master Guard）—— 防止主大脑"忘记派活、自己埋头干"
 *
 * 背景：多 Agent 模式下，主大脑应派活给 Worker；但 AI 常"忘记"（提示词约束不可靠）。
 * 本模块用工程手段兜底：检测主大脑在多 Agent 模式下的"自干行为"，超过阈值就注入提醒。
 *
 * 判定逻辑：
 *   - 仅多 Agent 模式（mode.isMulti）
 *   - 该窗口是"主大脑"（有活跃子任务或未完成计划）→ 说明本应派活
 *   - 连续执行 JS 代码块次数 >= 阈值 → 注入"请派活"提醒
 *
 * 豁免（视为合理，不计数）：
 *   - 工具结果回传 / 心跳 / 看门狗相关（isFeedback 类）
 *   - 单聊模式
 *   - 没有 Worker 窗口可用（无人可派，只能自己干）
 */
const NL = String.fromCharCode(10);

const CONFIG = {
  windowMs: 120000,   // 统计窗口：2 分钟内
  threshold: 3,       // 连续自干 >= 3 次 → 提醒
  cooldownMs: 120000, // 提醒后冷却 2 分钟，避免刷屏
};

// profileId -> { times: [ts...], lastNudgeAt }
const state = new Map();

function getSt(profileId) {
  if (!state.has(profileId)) state.set(profileId, { times: [], lastNudgeAt: 0 });
  return state.get(profileId);
}

/** 是否为多 Agent 模式 */
function isMulti(profileId) {
  try { return require('./mode').isMulti(profileId); } catch (_) { return false; }
}

/** 该 profile 是否为"主大脑"（有活跃子任务或未完成计划） */
function isMaster(profileId) {
  try {
    const tm = require('./task-manager');
    if (tm.listActiveTasks && tm.listActiveTasks(profileId).length > 0) return true;
  } catch (_) {}
  try {
    const pm = require('./plan');
    const plan = pm.getPlan(profileId);
    if (plan) {
      pm.refresh(plan);
      const allDone = plan.modules.length > 0 && plan.modules.every(function (m) {
        return m.status === 'done' || m.status === 'skipped';
      });
      if (!allDone) return true;
    }
  } catch (_) {}
  return false;
}

/** 是否有空闲 Worker（无人可派就不该提醒） */
function hasFreeWorker(profileId) {
  try {
    const ws = require('../window');
    const ctxs = ws.getAllContexts();
    for (const c of ctxs) {
      if (c.profileId === profileId) continue;
      // 粗略：有其它打开窗口即视为"可能可派"
      return true;
    }
  } catch (_) {}
  return false;
}

/**
 * 记录一次"主大脑自干"（执行 JS 代码块）。
 * @param {string} profileId
 * @param {string} code 执行的代码（用于豁免判断）
 * @returns {{shouldNudge: boolean, count: number}} 是否应注入提醒
 */
function noteSelfWork(profileId, code) {
  if (!profileId) return { shouldNudge: false, count: 0 };
  if (!isMulti(profileId)) return { shouldNudge: false, count: 0 };
  if (!isMaster(profileId)) return { shouldNudge: false, count: 0 };
  if (!hasFreeWorker(profileId)) return { shouldNudge: false, count: 0 };

  // 豁免：只有"写操作"才算自干（主大脑正当职责不算）：
  //   - team_* 派活、read/grep/glob 只读、log 输出 → 全部豁免
  //   - 只有 write/edit/writeFile/editFile/delete/bash 这类才计数
  if (code && typeof code === 'string') {
    const writeOps = ['write(', 'writeFile(', 'edit(', 'editFile(', 'delete(', 'bash('];
    let hasWriteOp = false;
    for (let i = 0; i < writeOps.length; i++) {
      if (code.indexOf(writeOps[i]) !== -1) { hasWriteOp = true; break; }
    }
    if (!hasWriteOp) return { shouldNudge: false, count: 0 };
  }

  const st = getSt(profileId);
  const now = Date.now();
  // 滑动窗口：只保留 windowMs 内的
  st.times = st.times.filter(function (t) { return now - t < CONFIG.windowMs; });
  st.times.push(now);
  const count = st.times.length;

  if (count < CONFIG.threshold) return { shouldNudge: false, count: count };
  if (now - st.lastNudgeAt < CONFIG.cooldownMs) return { shouldNudge: false, count: count };

  st.lastNudgeAt = now;
  st.times = []; // 提醒后重置计数
  return { shouldNudge: true, count: count };
}

/** 构造提醒语 */
function buildNudge() {
  return [
    '【系统提醒·多 Agent】你处于多 Agent 模式（主大脑），但最近连续多次**亲自执行 JS**。',
    '',
    '请检查：是否忘了把任务**派发给 Worker**？',
    '- 用 team_get_workers_status() 看谁空闲',
    '- 用 team_dispatch_task / team_dispatch_batch 派发',
    '- 主大脑只做：拆解、派发、验收、决策——**不要自己埋头干**',
    '',
    '（若你确实在自干合理的小收尾/无 Worker 可用，忽略本条即可。）',
  ].join(NL);
}

function _reset() { state.clear(); }

module.exports = { noteSelfWork, buildNudge, CONFIG, _reset };
