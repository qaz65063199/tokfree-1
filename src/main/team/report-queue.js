/**
 * 收件队列（Report Queue）—— 主大脑的"秘书台"
 *
 * 解决的问题：多个子 Agent 差不多同时完成并回报时，若直接注入主大脑窗口，
 * 会瞬间涌入 N 条消息导致主大脑处理不过来 / 上下文被冲爆。
 *
 * 方案（融合 OpenClaw / billion-context-pi 的 trailing-edge 合并思想）：
 *  1. 入队即返回：worker 的回报只入队，绝不让 worker 等待
 *  2. 按 taskId 去重：同一任务只保留最新一条回报（旧回报被覆盖）
 *  3. 拖尾合并窗口：首次入队后 debounceMs 内继续收集，直到静默 debounceMs 或达硬上限 maxWindowMs
 *  4. 串行投递：同一时刻只投递一批，等主大脑处理完（空闲）再投下一批
 *  5. 优先级：ASK > DONE > SYNC
 *  6. 溢出保护：队列 cap，超出时丢弃最旧的 SYNC，并保留"被丢弃要点"
 *  7. 退出批次：窗口内被 team_read_inbox 消费的回报不重复投递
 *
 * 主大脑空闲判定：复用看门狗状态（expectingReply=false 且无 busy）
 */

const taskManager = require('./task-manager');
const windowState = require('../window');
const masterActivity = require('./master-activity');
const { inject: injectMessage } = require('../../core/agent-runtime/inject');

// ========== 配置 ==========
const CONFIG = {
  debounceMs: 2000,    // 静默多久后投递（拖尾合并）
  maxWindowMs: 10000,  // 从首个回报算起的硬上限，防止错峰完成饿死投递
  cap: 20,             // 队列积压上限
  pollMs: 1000,        // 空闲检测轮询间隔
};

// 心跳老化阈值（秒）：expectingReply 但心跳停滞超此值 → 视为空闲，防 hook 漏发 disarm 导致误判忙
const STALE_HEARTBEAT_SECS = 45;

// 待投递队列：taskId -> { taskId, level, content, module, ts }
const pending = new Map();
// 被丢弃的要点（溢出时保留）
let droppedNotes = [];
// 合并窗口计时
let firstEnqueueAt = 0;
let lastEnqueueAt = 0;
let flushTimer = null;
// 是否有批次正在等待主大脑处理
let delivering = false;
let deliveringCtx = null;
let deliveredAt = 0;

/** 回报级别优先级（数字越大越优先） */
const LEVEL_PRIORITY = { SYNC: 1, DONE: 2, ASK: 3 };

/**
 * 入队一条回报（worker 调用，立即返回）
 * @param {{taskId:string, level:string, content:string}} report
 */
function enqueue(report) {
  if (!report || !report.taskId) return false;
  const level = LEVEL_PRIORITY[report.level] ? report.level : 'SYNC';
  const task = taskManager.getTask(report.taskId);

  const item = {
    taskId: report.taskId,
    level,
    content: report.content || '',
    module: (task && task.module) || '',
    ts: new Date().toISOString(),
  };

  // 按 taskId 去重：同任务只保留最新一条（除非新级别更高）
  const existing = pending.get(report.taskId);
  if (existing && LEVEL_PRIORITY[existing.level] >= LEVEL_PRIORITY[level]) {
    // 保留原级别，仅更新内容
    existing.content = item.content;
    existing.ts = item.ts;
  } else {
    pending.set(report.taskId, item);
  }

  // 溢出保护：丢弃最旧的 SYNC
  while (pending.size > CONFIG.cap) {
    let oldestKey = null;
    let oldestTs = Infinity;
    let oldestLevel = 99;
    for (const [k, v] of pending) {
      const p = LEVEL_PRIORITY[v.level];
      if (p < oldestLevel || (p === oldestLevel && Date.parse(v.ts) < oldestTs)) {
        oldestLevel = p; oldestTs = Date.parse(v.ts); oldestKey = k;
      }
    }
    if (oldestKey) {
      const dropped = pending.get(oldestKey);
      droppedNotes.push('[' + (dropped.module || dropped.taskId) + '] ' + (dropped.content || '').slice(0, 120));
      if (droppedNotes.length > 10) droppedNotes = droppedNotes.slice(-10);
      pending.delete(oldestKey);
    } else break;
  }

  const now = Date.now();
  if (!firstEnqueueAt) firstEnqueueAt = now;
  lastEnqueueAt = now;
  scheduleFlush();
  return true;
}

/** 安排投递（拖尾合并窗口） */
function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    tryFlush();
  }, CONFIG.debounceMs);
}

/** 到达硬上限时强制投递 */
function checkHardLimit() {
  if (!firstEnqueueAt) return;
  if (Date.now() - firstEnqueueAt >= CONFIG.maxWindowMs) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    tryFlush();
  }
}

/**
 * 尝试投递：仅当有待投递、主大脑空闲、无批次在途时执行
 */
function tryFlush() {
  if (delivering) {
    // 已投递一批：等主大脑处理完（空闲）再释放，投递下一批
    if (deliveringCtx && Date.now() - deliveredAt > 2000) {
      if (isMasterIdle(deliveringCtx)) {
        delivering = false;
        deliveringCtx = null;
      }
    }
    return;
  }
  if (pending.size === 0) { firstEnqueueAt = 0; return; }

  // 找出这批回报对应的主大脑（取第一条的 masterProfileId；缺失则用主窗口）
  // 归属规则：指定了 masterProfileId → 只投该窗口，窗口不在则本批暂不投递（稍后重试），
  //          绝不 fallback 到主窗口/无关窗口；未指定（系统级）才用主窗口。
  const firstTaskId = pending.keys().next().value;
  const firstTask = taskManager.getTask(firstTaskId);
  const masterProfileId = (firstTask && firstTask.masterProfileId) || null;
  const masterCtx = masterProfileId
    ? windowState.getWindowByProfileId(masterProfileId)
    : windowState.getMainContext();
  if (!masterCtx || !masterCtx.win || masterCtx.win.isDestroyed()) {
    // 归属窗口不在，稍后重试（不跨窗口 fallback）
    return;
  }

  // 主大脑空闲判定（看门狗空闲 且 非"刚刚注入过"）
  if (!isMasterIdle(masterCtx)) return;
  if (masterActivity.isRecentlyInjected(masterCtx.profileId)) return;

  // 组装批次
  const items = Array.from(pending.values()).sort(
    (a, b) => LEVEL_PRIORITY[b.level] - LEVEL_PRIORITY[a.level] || Date.parse(a.ts) - Date.parse(b.ts)
  );
  pending.clear();
  firstEnqueueAt = 0;

  const message = buildBatchMessage(items, masterProfileId);
  deliver(masterCtx, message);
}

/**
 * 主大脑是否空闲（可接收回报注入）
 *
 * ⚠️ 关键：不能简单用 expectingReply 判断——Manager 派发任务后回复完，
 * 会进入「完成确认」模式（mode='confirm'），此时 expectingReply 仍为 true，
 * 但它其实已经回复完、在等确认，应当视为空闲。否则回报永远投递不进去，
 * 表现为「多 Agent 只能调动一次」。
 */
function isMasterIdle(ctx) {
  try {
    const watchdog = require('../watchdog');
    const res = watchdog.getStatus(ctx.profileId);
    const p = res && res.profile;
    if (!p) return true;
    // 长任务中（busy）→ 不打扰
    if (p.busy) return false;
    // 完成确认模式：已回复完，仅等确认 → 视为空闲，可接收回报
    if (p.mode === 'confirm') return true;
    // 其余 awaiting 情况（正在生成/流式中）→ 不打扰；但心跳老化（hook 漏发 disarm）则视为空闲
    if (p.expectingReply && (p.heartbeatAge || 0) < STALE_HEARTBEAT_SECS) return false;
    return true;
  } catch (_) {
    return true;
  }
}

/**
 * 把批次消息注入主大脑窗口
 */
function deliver(ctx, message) {
  delivering = true;
  deliveringCtx = ctx;
  deliveredAt = Date.now();
  try { masterActivity.noteInject(ctx.profileId); } catch (_) {}
  try {
    injectMessage(ctx.profileId, message, ctx);
    console.log('[ReportQueue] 已投递批次到主大脑 ' + ctx.profileId + '，长度=' + message.length);
  } catch (err) {
    console.error('[ReportQueue] 投递失败:', err.message);
    delivering = false;
    deliveringCtx = null;
  }
}

/**
 * 组装批次消息
 */
function buildBatchMessage(items, masterProfileId) {
  const NL = String.fromCharCode(10);
  const parts = [];

  if (items.length === 1) {
    const it = items[0];
    const label = { SYNC: '进度', DONE: '完成', ASK: '求助' }[it.level] || '回报';
    parts.push('【子任务' + label + '】[' + (it.module || it.taskId) + ']');
    parts.push(it.content);
  } else {
    const asks = items.filter((i) => i.level === 'ASK').length;
    const dones = items.filter((i) => i.level === 'DONE').length;
    parts.push('【子任务回报 · 共 ' + items.length + ' 条' +
      (dones ? '，' + dones + ' 完成' : '') + (asks ? '，' + asks + ' 求助' : '') + '】');
    parts.push('');
    items.forEach((it, i) => {
      const label = { SYNC: '进度', DONE: '完成', ASK: '求助' }[it.level] || '回报';
      parts.push((i + 1) + '. [' + label + '][' + (it.module || it.taskId) + '] ' + it.content);
    });
  }

  // 仍在运行的任务
  const active = masterProfileId ? taskManager.listActiveTasks(masterProfileId) : [];
  const doneIds = new Set(items.map((i) => i.taskId));
  const stillRunning = active.filter((t) => !doneIds.has(t.id));
  parts.push('');
  if (stillRunning.length > 0) {
    parts.push('仍有 ' + stillRunning.length + ' 个子任务在运行：' +
      stillRunning.map((t) => (t.module || t.id)).join('、'));
  } else {
    parts.push('当前没有其他子任务在运行。');
  }

  // 空闲可用的 Worker（供主大脑持续派活）
  try {
    const windowState = require('../window');
    const profiles = require('../profile-manager').readProfiles();
    const ctxs = windowState.getAllContexts();
    const busyProfileIds = new Set(active.map((t) => t.profileId));
    const idle = ctxs.filter((c) => c.profileId !== masterProfileId && !busyProfileIds.has(c.profileId));
    if (idle.length > 0) {
      const names = idle.map((c) => {
        const pr = profiles.find((x) => x.id === c.profileId);
        return (pr ? pr.name : c.profileId);
      });
      parts.push('');
      parts.push('空闲可用的 Worker（可立即派新任务）：' + names.join('、'));
    }
  } catch (_) {}

  if (droppedNotes.length > 0) {
    parts.push('');
    parts.push('（注意：因回报过密，以下较旧的进度已合并省略）');
    droppedNotes.forEach((n) => parts.push('- ' + n));
    droppedNotes = [];
  }

  parts.push('');
  parts.push('请用 team_get_progress / team_read_inbox(taskId) 查看详情，并据此更新进度、取消已完成事项、或回复求助。');
  return parts.join(NL);
}

/** 启动空闲轮询（持续尝试投递积压批次） */
let pollTimer = null;
function start() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    checkHardLimit();
    tryFlush();
  }, CONFIG.pollMs);
}

function stop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/** 标记某 taskId 的回报已被消费（退出批次，不重复投递） */
function consume(taskId) {
  if (pending.has(taskId)) pending.delete(taskId);
}

/** 队列状态（调试/监控） */
function status() {
  return { pending: pending.size, delivering, dropped: droppedNotes.length, firstEnqueueAt, lastEnqueueAt };
}

module.exports = { enqueue, start, stop, consume, status, CONFIG, buildBatchMessage, isMasterIdle };
