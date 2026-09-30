/**
 * 自驱循环驱动器（Self-Loop Driver）—— 让飞轮无人干预地转起来
 *
 * 把 self-loop.js（目标/决策）接上"执行"：定期检查运行中的目标，
 * 在 AI 空闲时注入"下一轮"指令，形成闭环：
 *
 *   人类设目标 → [驱动器每 tick 检查] → AI 空闲 → 注入下一轮指令
 *     → AI 执行/复盘/生成技能 → 记录一轮 → 再检查 → ...
 *   直到达标 / 轮次耗尽 / 超时 / 用户中止。
 *
 * 关键：与 watchdog 协作判断 AI 是否空闲，避免打断正在进行的生成。
 */
const selfLoop = require('./self-loop');
const masterActivity = require('./master-activity');
const windowState = require('../window');
const fs = require('fs');
const path = require('path');
const { getBaseDir } = require('../../core/agent-runtime/paths');
const { inject: injectMessage } = require('../../core/agent-runtime/inject');
// 自进化飞轮总开关（默认关；缺失时视为关闭）：控制本驱动器是否运行
let evolutionSwitch = null;
try { evolutionSwitch = require('./evolution-switch'); } catch (_) { evolutionSwitch = null; }

/** 总开关是否开启（缺失/异常 → 视为关闭） */
function isEvolutionEnabled() {
  try { return !!(evolutionSwitch && evolutionSwitch.isEnabled()); } catch (_) { return false; }
}
// 防呆层（惰性引用，缺失时降级不影响主流程）
let guard = null;
try { guard = require('./self-loop-guard'); } catch (_) { guard = null; }

/** 取某窗口当前项目目录（无则空串）；复用 curator 的同名逻辑思路 */
function getCtxProjectDir(ctx) {
  try {
    return (ctx && ctx.sessionStore && ctx.sessionStore.state && ctx.sessionStore.state.selectedProjectDir) || '';
  } catch (_) { return ''; }
}

/** 该窗口是否「适合被引导」（排除子 Agent/Worker，避免主从对话被打乱） */
function isGuidableWindow(profileId) {
  if (!profileId) return false;
  try {
    const tm = require('./task-manager');
    if (tm.isWorkerProfile && tm.isWorkerProfile(profileId)) return false;
  } catch (_) {}
  try {
    const pm = require('../profile-manager');
    const p = pm.getProfileById(profileId);
    if (p && p.role === 'worker') return false;
  } catch (_) {}
  return true;
}

const CONFIG = {
  tickMs: 60000,       // 每 60 秒检查一次
  minGapSec: 120,      // 同一目标两次注入最小间隔（给 AI 干活时间）
  turnEndGapSec: 8,    // 回合内快速路径：同一目标两次注入最小间隔（秒）
  turnEndDelayMs: 15000, // 回合结束后延迟复查时长（避开工具循环中的多次「回合结束」）
  quietSecs: 10,       // 回合结束后要求的静默时长（秒），不足则取消注入
};

const lastInjectAt = new Map(); // goalId -> ts
const lastInjectRound = new Map(); // goalId -> 注入时的 round 值
const turnEndTimers = new Map(); // profileId -> 回合延迟复查定时器句柄
const lastTurnEndAt = new Map(); // profileId -> 最近一次回合结束时刻
const notifiedGoals = new Set(); // 已通知过的目标（防重复，持久化到磁盘）
let notifiedLoaded = false; // 是否已从磁盘加载
let NOTIFIED_FILE = null;
let timer = null;
let unsubResponse = null; // 回合内快速路径：response-bus 订阅句柄

/** 通知记录文件路径（惰性，参照 self-loop.js 的 getFile） */
function getNotifiedFile() {
  if (!NOTIFIED_FILE) {
    const dir = path.join(getBaseDir(), 'self-loop');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    NOTIFIED_FILE = path.join(dir, 'notified.json');
  }
  return NOTIFIED_FILE;
}

/** 从磁盘加载「已通知」记录（幂等；app 未就绪时下次重试） */
function loadNotified() {
  if (notifiedLoaded) return;
  try {
    const f = getNotifiedFile();
    notifiedLoaded = true;
    if (fs.existsSync(f)) {
      const obj = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (obj && Array.isArray(obj.notified)) {
        for (const id of obj.notified) notifiedGoals.add(id);
      }
    }
  } catch (e) {
    console.error('[SelfLoop] 加载通知记录失败:', e.message);
  }
}

/** 把「已通知」记录写回磁盘 */
function saveNotified() {
  try {
    fs.writeFileSync(getNotifiedFile(), JSON.stringify({ notified: Array.from(notifiedGoals) }, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[SelfLoop] 保存通知记录失败:', e.message);
    return false;
  }
}

/** 目标结束时通知用户（达标/完美/熔断/达上限） */
function notifyGoalEnd(ctx, goal) {
  if (!goal || notifiedGoals.has(goal.id)) return;
  loadNotified();
  notifiedGoals.add(goal.id);
  saveNotified();
  try {
    const deliverable = require('./deliverable');
    const eventMap = { achieved: 'achieved', perfect: 'achieved', exhausted: 'exhausted', aborted: 'circuit-break' };
    const n = deliverable.shouldNotify(goal.id, eventMap[goal.status] || 'achieved');
    if (!n || !n.notify) return;
    const report = deliverable.buildGoalReport(goal.id);
    // 注入通知 + 报告到目标窗口
    if (ctx && ctx.win && !ctx.win.isDestroyed()) {
      injectMessage(ctx.profileId, n.message + String.fromCharCode(10) + String.fromCharCode(10) + report + String.fromCharCode(10) + String.fromCharCode(10) + '（自驱循环已结束，这是最终成果报告。请向用户简要汇报，不再继续循环。）', ctx);
    }
    console.log('[SelfLoop] 已通知目标结束: ' + goal.id + ' (' + goal.status + ')');
  } catch (e) {
    console.error('[SelfLoop] 通知失败:', e.message);
  }
}

/** AI 是否空闲（可接收下一轮指令） */
function isTargetIdle(profileId) {
  try {
    const watchdog = require('../watchdog');
    const res = watchdog.getStatus(profileId);
    const p = res && res.profile;
    if (!p) return true;
    if (p.busy) return false;
    if (p.mode === 'confirm') return true;
    if (p.expectingReply) return false;
    return true;
  } catch (_) { return true; }
}

/** 注入消息到目标窗口 */
function inject(ctx, message) {
  try {
    injectMessage(ctx.profileId, message, ctx);
    masterActivity.noteInject(ctx.profileId);
    console.log('[SelfLoop] 已注入下一轮指令到 ' + ctx.profileId);
    return true;
  } catch (e) {
    console.error('[SelfLoop] 注入失败:', e.message);
    return false;
  }
}

/** 一次 tick：推进所有运行中的目标 */
function tick() {
  // 总开关关 → 不注入（运行时切换即时生效）
  if (!isEvolutionEnabled()) return;
  loadNotified();
  // 先检查：已结束的目标是否需要通知
  try {
    const all = selfLoop.listGoals();
    for (const gg of all) {
      if (gg.status !== 'running' && !notifiedGoals.has(gg.id)) {
        // 有 profileId：只用其对应窗口，找不到就跳过（不 fallback 到无关主窗口）；
        // 未指定 profileId：才用主窗口
        const ctx = gg.profileId ? windowState.getWindowByProfileId(gg.profileId) : windowState.getMainContext();
        if (ctx && ctx.win && !ctx.win.isDestroyed()) notifyGoalEnd(ctx, gg);
      }
    }
  } catch (_) {}

  let goals;
  try { goals = selfLoop.listRunningGoals(); } catch (_) { return; }
  if (!goals || goals.length === 0) return;

  for (const g of goals) {
    try {
      // 防呆：健康检查（死循环/成本/停滞/异常熔断）
      if (guard) {
        try {
          const h = guard.checkGoalHealth(g.id);
          if (h && (h.action === 'stop' || h.action === 'circuit-break')) {
            console.log('[SelfLoop] 目标 ' + g.id + ' 触发' + (h.action === 'stop' ? '停止' : '熔断') + ': ' + (h.issues || []).join('; '));
            selfLoop.abortGoal(g.id, '防呆层' + (h.action === 'stop' ? '停止' : '熔断') + ': ' + (h.issues || []).join('; '));
            continue;
          }
        } catch (_) {}
      }
      // 找目标窗口：指定 profileId → 只用该窗口，找不到就跳过（绝不 fallback 到主窗口/无关窗口）；
      // 未指定 profileId（系统级目标）→ 才用主窗口。
      let ctx;
      if (g.profileId) {
        ctx = windowState.getWindowByProfileId(g.profileId);
        if (!ctx) {
          console.log('[SelfLoop] 目标 ' + g.id + ' 的窗口不可用，已跳过（不 fallback）: ' + g.profileId);
          continue;
        }
      } else {
        ctx = windowState.getMainContext();
      }
      if (!ctx || !ctx.win || ctx.win.isDestroyed()) continue;
      // 按项目归属校验：goal 指定了 projectDir → 窗口的项目目录必须一致，否则跳过（绝不 fallback 到无关项目窗口）。
      // goal 无 projectDir（无归属/老数据）→ 维持现状，不做项目校验。
      if (g.projectDir && getCtxProjectDir(ctx) !== g.projectDir) {
        console.log('[SelfLoop] 目标 ' + g.id + ' 的项目不匹配，已跳过（窗口=' + getCtxProjectDir(ctx) + '，目标=' + g.projectDir + '）');
        continue;
      }
      // 跳过子 Agent/Worker 窗口（避免打乱主从协作）
      if (!isGuidableWindow(ctx.profileId)) continue;

      // 注入风暴防护
      if (guard) { try { if (!guard.canInject(ctx.profileId)) continue; } catch (_) {} }
      // AI 正忙 → 等
      if (!isTargetIdle(ctx.profileId)) continue;
      // 刚注入过 → 等（给 AI 干活时间）
      const last = lastInjectAt.get(g.id) || 0;
      if (Date.now() - last < CONFIG.minGapSec * 1000) continue;

      // 单窗口兜底：上次注入后 round 没变（AI 可能忘了记录）→ 从轨迹自动推断
      const ir = lastInjectRound.get(g.id);
      if (ir !== undefined && ir === g.round) {
        const lastAt = lastInjectAt.get(g.id) || 0;
        if (Date.now() - lastAt > CONFIG.minGapSec * 1000 * 2) {
          try {
            const r = selfLoop.inferRoundFromTrace(g.id);
            if (r && r.inferred) {
              console.log('[SelfLoop] 目标 ' + g.id + ' 自动推断一轮（AI 未记录）: ' + r.outcome);
              lastInjectRound.set(g.id, (r.goal && r.goal.round) || g.round + 1);
              continue;
            }
          } catch (_) {}
        }
      }

      // 决定下一步
      const d = selfLoop.decideNextAction(g.id);
      if (!d || d.action === 'done' || d.action === 'none') continue;

      // 构造并注入指令
      const msg = selfLoop.buildNextRoundPrompt(g.id);
      if (!msg) continue;
      if (inject(ctx, msg)) {
        lastInjectAt.set(g.id, Date.now());
        lastInjectRound.set(g.id, g.round);
        if (guard) { try { guard.recordInject(ctx.profileId); } catch (_) {} }
      }
    } catch (e) {
      console.error('[SelfLoop] tick 处理异常:', e.message);
    }
  }
}

/**
 * 回合结束回调（onTurnEnd）——不再同步注入，改为「延迟复查」。
 *
 * AI 在工具循环中会多次「回复完成」（每次输出代码块→执行→再回复），
 * 若在每次回合结束时同步注入下一轮指令，会在 AI 实际还在干活时把它打断。
 * 因此这里只做两件事：记录该窗口的回合结束时刻 + 设置一个延迟定时器；
 * turnEndDelayMs 后由 runTurnEndInject 复查（再次确认 AI 空闲 + 期间无新回合）再注入。
 * 同一 profileId 的 pending 定时器只保留最新一个（新回合结束会清掉旧的）。
 * @param {string} profileId AI 回复完成的窗口
 */
function onTurnEnd(profileId) {
  try {
    if (!isEvolutionEnabled()) return;
    if (!profileId) return;
    const now = Date.now();
    lastTurnEndAt.set(profileId, now);
    // 同一 profileId 的 pending 定时器只保留最新一个（新回合结束清掉旧的）
    const old = turnEndTimers.get(profileId);
    if (old) { try { clearTimeout(old); } catch (_) {} turnEndTimers.delete(profileId); }
    const t = setTimeout(function () {
      turnEndTimers.delete(profileId);
      try {
        runTurnEndInject(profileId, now);
      } catch (e) {
        console.error('[SelfLoop] 回合延迟注入异常:', e.message);
      }
    }, CONFIG.turnEndDelayMs);
    if (t.unref) t.unref();
    turnEndTimers.set(profileId, t);
  } catch (e) {
    console.error('[SelfLoop] onTurnEnd 调度异常:', e.message);
  }
}

/**
 * 延迟复查后的实际注入逻辑（原 onTurnEnd 主体）。
 * 复用 tick 的 per-goal 守卫（健康检查 / 项目归属 / isGuidableWindow / 注入风暴 / 空闲判断）。
 * 额外守卫：
 *   a) 再次确认 isTargetIdle(profileId) 为 true（AI 空闲）；
 *   b) 自回合结束后若又有新的回合结束（lastTurnEndAt 变化）→ AI 又动了 → 取消本次注入。
 * 只处理「该 profileId 的 running goal」；无归属 goal 只在该 profileId 为主窗口时处理。
 * 不触发 tick 的「轨迹自动推断」——这是机会型快路径。
 * @param {string} profileId AI 回复完成的窗口
 * @param {number} scheduledAt 触发本次复查的回合结束时刻
 */
function runTurnEndInject(profileId, scheduledAt) {
  if (!isEvolutionEnabled()) return;
  if (!profileId) return;
  // 守卫 a：再次确认 AI 空闲
  if (!isTargetIdle(profileId)) {
    console.log('[SelfLoop] 回合延迟注入：AI 非空闲，取消 ' + profileId);
    return;
  }
  // 守卫 b：回合结束后又发生了新的回合结束 → AI 又动了，取消本次注入
  const latest = lastTurnEndAt.get(profileId);
  if (latest !== undefined && latest !== scheduledAt) {
    console.log('[SelfLoop] 回合延迟注入：期间出现新回合，取消 ' + profileId);
    return;
  }
  // 守卫 c：静默时长不足（quietSecs 兜底）→ 取消
  if (Date.now() - (latest || 0) < CONFIG.quietSecs * 1000) {
    console.log('[SelfLoop] 回合延迟注入：静默时长不足，取消 ' + profileId);
    return;
  }
  let goals;
  try { goals = selfLoop.listRunningGoals(); } catch (_) { return; }
  if (!goals || goals.length === 0) return;

  // 该窗口是否为主窗口（无归属 goal 只允许主窗口处理）
  let isMain = false;
  try {
    const mc = windowState.getMainContext();
    isMain = !!(mc && mc.profileId === profileId);
  } catch (_) {}

  for (const g of goals) {
    try {
      // 归属过滤：指定 profileId 的 goal 只由其窗口处理；无归属 goal 只由主窗口处理
      if (g.profileId) {
        if (g.profileId !== profileId) continue;
      } else if (!isMain) {
        continue;
      }

      // 防呆：健康检查（死循环/成本/停滞/异常熔断）
      if (guard) {
        try {
          const h = guard.checkGoalHealth(g.id);
          if (h && (h.action === 'stop' || h.action === 'circuit-break')) {
            console.log('[SelfLoop] 目标 ' + g.id + ' 触发' + (h.action === 'stop' ? '停止' : '熔断') + ': ' + (h.issues || []).join('; '));
            selfLoop.abortGoal(g.id, '防呆层' + (h.action === 'stop' ? '停止' : '熔断') + ': ' + (h.issues || []).join('; '));
            continue;
          }
        } catch (_) {}
      }
      // 找目标窗口：指定 profileId → 只用该窗口；无归属 → 主窗口
      let ctx;
      if (g.profileId) {
        ctx = windowState.getWindowByProfileId(g.profileId);
        if (!ctx) continue;
      } else {
        ctx = windowState.getMainContext();
      }
      if (!ctx || !ctx.win || ctx.win.isDestroyed()) continue;

      // 按项目归属校验
      if (g.projectDir && getCtxProjectDir(ctx) !== g.projectDir) continue;
      // 跳过子 Agent/Worker 窗口
      if (!isGuidableWindow(ctx.profileId)) continue;
      // 注入风暴防护
      if (guard) { try { if (!guard.canInject(ctx.profileId)) continue; } catch (_) {} }
      // AI 正忙 → 等
      if (!isTargetIdle(ctx.profileId)) continue;
      // 回合内短防抖（共用 lastInjectAt，避免与 tick 双注入）
      const last = lastInjectAt.get(g.id) || 0;
      if (Date.now() - last < CONFIG.turnEndGapSec * 1000) continue;

      // 决定下一步；达标/结束（done/none）不注入
      const d = selfLoop.decideNextAction(g.id);
      if (!d || d.action === 'done' || d.action === 'none') continue;

      const msg = selfLoop.buildNextRoundPrompt(g.id);
      if (!msg) continue;
      if (inject(ctx, msg)) {
        lastInjectAt.set(g.id, Date.now());
        lastInjectRound.set(g.id, g.round);
        if (guard) { try { guard.recordInject(ctx.profileId); } catch (_) {} }
      }
    } catch (e) {
      console.error('[SelfLoop] onTurnEnd 处理异常:', e.message);
    }
  }
}

function start() {
  if (timer) return;
  // 总开关关 → 不启动
  if (!isEvolutionEnabled()) {
    console.log('[SelfLoop] 自进化飞轮总开关关闭，自驱循环驱动器不启动');
    return;
  }
  timer = setInterval(tick, CONFIG.tickMs);
  if (timer.unref) timer.unref();
  // 回合内快速路径：订阅 AI 回复完成事件（主 Agent 无 taskId 路径）
  try {
    if (!unsubResponse) {
      const bus = require('./response-bus');
      unsubResponse = bus.onWorkerResponse(function (data) {
        try {
          if (!data || data.taskId) return; // 只处理主 Agent 的回合结束
          onTurnEnd(data.profileId);
        } catch (e) {
          console.error('[SelfLoop] 回合内注入异常:', e.message);
        }
      });
    }
  } catch (_) {}
  console.log('[SelfLoop] 自驱循环驱动器已启动，tick=' + (CONFIG.tickMs / 1000) + 's，回合内快速路径已订阅');
}
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  // 清理所有回合延迟复查定时器（避免泄漏）
  try {
    for (const t of turnEndTimers.values()) { try { clearTimeout(t); } catch (_) {} }
  } catch (_) {}
  turnEndTimers.clear();
  lastTurnEndAt.clear();
  try { if (unsubResponse) { unsubResponse(); unsubResponse = null; } } catch (_) {}
}

// 模块加载时尝试加载已通知记录（app 未就绪则留待首次 tick 重试）
loadNotified();

module.exports = { start, stop, tick, onTurnEnd, isTargetIdle, CONFIG };
