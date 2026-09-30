/**
 * 调度器（Scheduler）—— 保证 Manager 持续决策的驱动引擎
 *
 * 解决的问题：Manager 回复完一批回报后进入 confirm 模式，若不主动继续，
 * 编排链就断了（表现为「多 Agent 只能调动一次」）。本模块在合适时机主动向
 * Manager 注入「下一步」提示，形成闭环。
 *
 * 触发（任一）：
 *  - 计划全完成 → 催汇总验收
 *  - 有可派发(ready)模块 且 无进行中(assigned) → 催派活（核心）
 *  - 有 assigned 但全部疑似卡住 → 催核实/唤醒
 *  - 有 failed 模块 → 催决策
 *  - 只剩 pending（依赖未满足）→ 催检查上游
 *
 * 节流：同一 Manager 两次注入间隔 >= minGapSec；Manager 非空闲不注入。
 */

const planManager = require('./plan');
const ws = require('../window');
const taskManager = require('./task-manager');
const masterActivity = require('./master-activity');
const { inject: injectMessage } = require('../../core/agent-runtime/inject');

const CONFIG = {
  tickMs: 30000,
  minGapSec: 90,
  stuckSec: 300,
};

// 心跳老化阈值（秒）：expectingReply 但心跳停滞超此值 → 视为空闲，防 hook 漏发 disarm 导致误判忙
const STALE_HEARTBEAT_SECS = 45;

const lastNudgeAt = new Map();
let timer = null;

function isMasterIdle(ctx) {
  try {
    const watchdog = require('../watchdog');
    const res = watchdog.getStatus(ctx.profileId);
    const p = res && res.profile;
    if (!p) return true;
    if (p.busy) return false;
    if (p.mode === 'confirm') return true;
    if (p.expectingReply && (p.heartbeatAge || 0) < STALE_HEARTBEAT_SECS) return false;
    return true;
  } catch (_) { return true; }
}

function buildNudge(plan) {
  planManager.refresh(plan);
  const mods = plan.modules;
  if (!mods || mods.length === 0) return null;
  const done = mods.filter(function (m) { return m.status === 'done' || m.status === 'skipped'; });
  const assigned = mods.filter(function (m) { return m.status === 'assigned'; });
  const ready = mods.filter(function (m) { return m.status === 'ready'; });
  const pending = mods.filter(function (m) { return m.status === 'pending'; });
  const failed = mods.filter(function (m) { return m.status === 'failed'; });
  const NL = String.fromCharCode(10);
  const head = '【编排推进·系统】计划「' + (plan.goal || '未命名') + '」';
  if (done.length === mods.length) {
    return head + ' 的 ' + mods.length + ' 个模块已全部完成。请汇总验收（逐项核对产物），确认无遗漏后向用户交付最终结果，并用 team_plan_status 复查。';
  }
  if (assigned.length > 0) {
    let stuck = 0;
    assigned.forEach(function (m) {
      const st = taskManager.getTask(m.taskId);
      if (!st) return;
      try {
        const wa = require('../worker-activity');
        const ago = wa.getAgoSeconds(st.profileId);
        if (ago !== null && ago > CONFIG.stuckSec) stuck++;
      } catch (_) {}
    });
    if (stuck > 0 && stuck === assigned.length) {
      return head + ' 有 ' + stuck + ' 个子任务疑似卡住（超过 ' + Math.round(CONFIG.stuckSec / 60) + ' 分钟无活动）。请用 team_get_workers_status 核实，必要时 team_reply_to_worker 唤醒或重派。';
    }
    return null;
  }
  if (ready.length > 0) {
    // 检查是否有空闲 Worker；无则提示新建
    let idleCount = 0;
    try {
      const ctxs = ws.getAllContexts();
      const activeProfileIds = new Set();
      planManager.listActivePlans().forEach(function (pp) {
        pp.modules.forEach(function (m) {
          if (m.status === 'assigned' && m.assignee) activeProfileIds.add(m.assignee);
        });
      });
      ctxs.forEach(function (c) {
        if (c.profileId === plan.masterProfileId) return;
        if (activeProfileIds.has(c.profileId)) return;
        // 该窗口有活跃任务则不算空闲
        let busy = false;
        try {
          const watchdog = require('../watchdog');
          const st = watchdog.getStatus(c.profileId);
          const pf = st && st.profile; busy = !!(pf && ((pf.expectingReply && (pf.heartbeatAge || 0) < STALE_HEARTBEAT_SECS) || pf.busy));
        } catch (_) {}
        if (!busy) idleCount++;
      });
    } catch (_) {}
    const names = ready.map(function (m) { return m.name; }).join('、');
    if (idleCount === 0) {
      return head + ' 还有 ' + ready.length + ' 个模块可派发（' + names + '），但**当前没有空闲 Worker**。请用 team_get_workers_status 确认，若确实无空闲，用 team_create_window 新建 Worker 窗口后派发。不要停下。';
    }
    return head + ' 还有 ' + ready.length + ' 个模块可派发（' + names + '），当前有 ' + idleCount + ' 个空闲 Worker。请立即派发下一个任务，不要停下。';
  }
  if (failed.length > 0) {
    return head + ' 有 ' + failed.length + ' 个模块失败（' + failed.map(function (m) { return m.name; }).join('、') + '）。请决策：重派 / 换 Worker / 亲自处理。';
  }
  if (pending.length > 0) {
    return head + ' 剩余 ' + pending.length + ' 个模块在等待上游依赖完成。请检查上游子任务是否卡住（team_get_workers_status）。';
  }
  return null;
}

function inject(ctx, message) {
  try {
    injectMessage(ctx.profileId, message, ctx);
    try { masterActivity.noteInject(ctx.profileId); } catch (_) {}
    console.log('[Scheduler] 已向主大脑 ' + ctx.profileId + ' 注入编排推进提示');
  } catch (e) {
    console.error('[Scheduler] 注入失败:', e.message);
  }
}

function tick() {
  let plans;
  try { plans = planManager.listActivePlans(); } catch (_) { return; }
  plans.forEach(function (plan) {
    try {
      // 归属规则：计划指定了 masterProfileId → 只投该窗口，窗口不在则跳过（不 fallback 到主窗口/无关窗口）
      const ctx = ws.getWindowByProfileId(plan.masterProfileId);
      if (!ctx || !ctx.win || ctx.win.isDestroyed()) return;
      if (!isMasterIdle(ctx)) return;
      // 队列/调度器互斥：若刚刚注入过（15s 内），本轮跳过
      if (masterActivity.isRecentlyInjected(plan.masterProfileId)) return;
      const last = lastNudgeAt.get(plan.masterProfileId) || 0;
      if (Date.now() - last < CONFIG.minGapSec * 1000) return;
      const msg = buildNudge(plan);
      if (!msg) return;
      lastNudgeAt.set(plan.masterProfileId, Date.now());
      plan.nudgeCount = (plan.nudgeCount || 0) + 1;
      inject(ctx, msg);
    } catch (e) {
      console.error('[Scheduler] tick 处理异常:', e.message);
    }
  });
}

function start() {
  if (timer) return;
  timer = setInterval(tick, CONFIG.tickMs);
  if (timer.unref) timer.unref();
  console.log('[Scheduler] 已启动，tick=' + (CONFIG.tickMs / 1000) + 's');
}
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, tick, buildNudge, CONFIG };
