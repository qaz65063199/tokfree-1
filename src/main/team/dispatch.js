/**
 * AI 协作：任务派发（主大脑 → 次大脑）
 * 派发时自动为 Worker 开启新对话、初始化项目上下文，
 * 并把「系统提示词 + 任务内容」合并为一条消息发送。
 * 次大脑据此作为完整 Agent 独立执行；仅在回复含同步暗号时回传主大脑。
 */
const windowState = require('../window');
const taskManager = require('./task-manager');
const profileManager = require('../profile-manager');
const { getProvider } = require('../../providers');
const { initProject } = require('../project-context');
const eventLog = require('../event-log');

// profileId -> { taskId, prompt, projectDir }：等待 Worker 新对话加载完成后发送
const pendingDispatches = new Map();

// taskId -> 定时器：等待 Worker ack（双向确认）。Worker 未在期限内确认则记录警告。
const ackTimers = new Map();
const ACK_TIMEOUT_MS = 5000;

/**
 * 登记一个"等待 ack"的定时器：超时仍未收到 Worker 确认则记录警告，
 * 供主 Agent 排查（Worker 窗口卡住 / 未加载）。
 * @param {string} taskId
 * @param {string} profileId
 */
function armAckTimer(taskId, profileId) {
  clearAckTimer(taskId);
  const timer = setTimeout(() => {
    ackTimers.delete(taskId);
    const task = taskManager.getTask(taskId);
    if (!task || task.ackAt) return; // 已确认或任务已不存在
    const msg = 'Worker 未在 ' + (ACK_TIMEOUT_MS / 1000) + 's 内确认收到任务（taskId=' + taskId + ', profile=' + profileId + '）';
    console.warn('[TeamDispatch] ' + msg);
    eventLog.recordEvent({
      profileId,
      type: 'error',
      sub: 'ack-timeout',
      detail: msg,
      meta: { taskId },
    });
  }, ACK_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  ackTimers.set(taskId, timer);
}

/** 清除某任务的 ack 定时器（收到确认或派发失败时调用） */
function clearAckTimer(taskId) {
  const timer = ackTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    ackTimers.delete(taskId);
  }
}

/**
 * 派发任务给指定 Worker 窗口
 * @param {string} profileId 目标 Worker
 * @param {string} prompt 任务内容
 * @param {string} [projectDir] 项目目录（自动初始化用）；缺省时沿用 Worker 当前目录
 * @param {object} [opts] { module, masterProfileId, mode }
 *   mode: 'fresh'（默认）开新对话重新初始化；'continue' 在原对话继续派发（复用上下文）；
 *         'session' 按已绑定会话续派（导航回原会话，找不到则降级 fresh）。
 * @returns {Promise<{success:boolean, taskId?:string, mode?:string, error?:string}>}
 */
async function dispatchTask(profileId, prompt, projectDir, opts = {}) {
  if (!profileId || !prompt) {
    return { success: false, error: '缺少 profileId 或 prompt' };
  }
  // 兜底角色拦截（与 tools/TeamTools.js 双重保险）：
  //   ① 调用者必须为 master（opts.masterProfileId 为空则放行，兼容单聊/无上下文场景）；
  //   ② 目标不能是 master（master 应坚守岗位收回报，不能互相派发）。
  try {
    const rm = require('./role-manager');
    if (opts.masterProfileId) {
      const callerRole = rm.getRole(opts.masterProfileId);
      if (callerRole.role !== 'master') {
        return { success: false, error: '只有主大脑（master）可以派发任务，请独立完成自己的任务。' };
      }
    }
    const targetRole = rm.getRole(profileId);
    if (targetRole.role === 'master') {
      return { success: false, error: '不能向另一个主大脑（master）派发任务，请选择 worker 窗口。' };
    }
  } catch (_) {}
  // 禁止把任务派发给调用者自己（主大脑窗口），否则会覆盖主大脑对话
  let masterId = opts.masterProfileId;
  if (!masterId) {
    const mc = windowState.getMainContext();
    masterId = mc ? mc.profileId : null;
  }
  if (masterId && profileId === masterId) {
    return { success: false, error: '不能把任务派发给主大脑自己，请选择其他 Worker 窗口' };
  }
  // 同一 Worker 已有进行中任务时拒绝重复派发，避免 taskId 绑定被覆盖
  if (taskManager.isWorkerProfile && taskManager.isWorkerProfile(profileId)) {
    return { success: false, error: '该 Worker 已有进行中的任务，请等它完成或换一个 Worker' };
  }
  // 同一 Worker 已有"待发送"的派发（尚未发出去）时也拒绝，避免 pendingDispatches 被覆盖丢任务
  if (pendingDispatches.has(profileId)) {
    return { success: false, error: '该 Worker 有派发中的任务尚未发送完成，请稍候再派' };
  }
  const ctx = windowState.getWindowByProfileId(profileId);
  if (!ctx || !ctx.win || ctx.win.isDestroyed()) {
    return { success: false, error: '目标 Worker 窗口未打开或已销毁，请先打开该 Profile 窗口' };
  }

  // ===== continue 模式：不开新对话、不 loadURL、不 initProject =====
  // 直接创建新 task 绑定到 worker，并通过原对话通道（master-inject-message）追加任务，
  // 复用 Worker 已有上下文（相关任务续派场景）。
  let mode = 'fresh';
  if (opts && opts.mode === 'continue') mode = 'continue';
  else if (opts && opts.mode === 'session') mode = 'session';

  // 派发前读 Worker 窗口当前会话 ID（用于记录/续派）
  const currentSessionId = (ctx.sessionStore && ctx.sessionStore.state && ctx.sessionStore.state.currentSessionId) || '';

  if (mode === 'continue') {
    try {
      const task = taskManager.createTask(profileId, prompt, {
        module: opts.module,
        masterProfileId: opts.masterProfileId,
        waveId: opts.waveId,
        sessionId: currentSessionId,
      });
      taskManager.updateTaskStatus(task.id, 'DISPATCHED');
      try { require('./role-manager').setWorker(profileId, masterId); } catch (_) {}
      try {
        if (opts.masterProfileId) {
          require('./plan').bindTaskToReadyModule(opts.masterProfileId, task.id, opts.module);
        }
      } catch (_) {}
      eventLog.recordEvent({ profileId, type: 'dispatch', sub: 'dispatch-continue', meta: { taskId: task.id, module: opts.module } });
      // 绑定 taskId（原对话内绑定，Worker 据此回报）
      try { ctx.win.webContents.send('worker-bind-task', { taskId: task.id }); } catch (_) {}
      // 通过原对话通道追加任务（复用 reply 的注入通道）
      try { ctx.win.webContents.send('master-inject-message', { message: prompt }); } catch (_) {}
      // 双向确认：等待 Worker ack（同 fresh）
      armAckTimer(task.id, profileId);
      return { success: true, taskId: task.id, mode: 'continue' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ===== session 模式：导航回已绑定会话，在原会话继续派发 =====
  // 比 continue 更稳：即使 Worker 当前不在原会话（被手动切换过），也能导航回去；
  // 若会话找不到（被删/平台变），降级为 fresh（新对话 + 初始化 + 派发）。
  if (mode === 'session') {
    // sessionId 来源：显式入参 > 该 Worker 最近一次任务记录 > Worker 当前会话
    let sessionId = opts.sessionId || '';
    if (!sessionId) {
      const last = taskManager.getLatestTaskByProfile(profileId);
      sessionId = (last && last.sessionId) || '';
    }
    if (!sessionId) sessionId = currentSessionId;

    let navigated = false;
    if (sessionId) {
      try {
        const provider = getProvider(ctx.providerId) || getProvider('deepseek');
        const base = provider && provider.sessionUrlBase;
        if (base) {
          const url = base + sessionId;
          await ctx.win.webContents.loadURL(url);
          // 校验：导航后 URL 应含目标会话 ID（或 provider 能识别出同一会话）
          const finalUrl = ctx.win.webContents.getURL();
          const parsed = (provider && typeof provider.extractSessionId === 'function')
            ? provider.extractSessionId(finalUrl) : null;
          if (finalUrl && (finalUrl.indexOf(sessionId) !== -1 || parsed === sessionId)) {
            navigated = true;
          }
        }
      } catch (_) { navigated = false; }
    }

    if (navigated) {
      try {
        const task = taskManager.createTask(profileId, prompt, {
          module: opts.module,
          masterProfileId: opts.masterProfileId,
          waveId: opts.waveId,
          sessionId,
        });
        taskManager.updateTaskStatus(task.id, 'DISPATCHED');
        try { require('./role-manager').setWorker(profileId, masterId); } catch (_) {}
        try {
          if (opts.masterProfileId) {
            require('./plan').bindTaskToReadyModule(opts.masterProfileId, task.id, opts.module);
          }
        } catch (_) {}
        eventLog.recordEvent({ profileId, type: 'dispatch', sub: 'dispatch-session', meta: { taskId: task.id, module: opts.module, sessionId } });
        // 绑定 taskId + 在原会话内续派（复用 reply 的注入通道）
        try { ctx.win.webContents.send('worker-bind-task', { taskId: task.id }); } catch (_) {}
        try { ctx.win.webContents.send('master-inject-message', { message: prompt }); } catch (_) {}
        armAckTimer(task.id, profileId);
        return { success: true, taskId: task.id, mode: 'session' };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
    // 会话不存在 / 导航失败 → 降级 fresh（继续走下方新对话流程）
    mode = 'fresh';
  }

  // 确定项目目录：优先入参，其次 Worker 已初始化的目录
  let dir = projectDir || (ctx.sessionStore && ctx.sessionStore.state.selectedProjectDir) || null;
  // 多标签 webview 架构兜底：Worker 常未初始化项目，回退到主大脑的项目目录，避免派发被拒
  if (!dir && masterId) {
    const mctx = windowState.getWindowByProfileId(masterId);
    dir = (mctx && mctx.sessionStore && mctx.sessionStore.state.selectedProjectDir) || null;
  }
  if (!dir) {
    return { success: false, error: '缺少 projectDir，且该 Worker 尚未初始化项目目录' };
  }

  const task = taskManager.createTask(profileId, prompt, {
    module: opts.module,
    masterProfileId: opts.masterProfileId,
    waveId: opts.waveId,
  });
  taskManager.updateTaskStatus(task.id, 'DISPATCHED');
  // 标记该 profile 为「子 Agent（Worker）」：持久化，供引导者(curator)识别并跳过
  try { require('./role-manager').setWorker(profileId, masterId); } catch (_) {}
  // 若主大脑已有编排计划，把本任务绑定到对应 ready 模块（推进 DAG）
  try {
    if (opts.masterProfileId) {
      require('./plan').bindTaskToReadyModule(opts.masterProfileId, task.id, opts.module);
    }
  } catch (_) {}
  eventLog.recordEvent({ profileId, type: 'dispatch', sub: 'dispatch', meta: { taskId: task.id, module: opts.module } });
  pendingDispatches.set(profileId, { taskId: task.id, prompt, projectDir: dir });

  const win = ctx.win;
  // 新对话加载完成后发送系统提示词 + 任务。
  // 兜底：若 loadURL 与当前 URL 相同（Worker 已在 homeUrl），did-finish-load
  // 可能不触发，导致任务永远发不出去。加一次性防护 + 超时兜底。
  let dispatched = false;
  const fireOnce = (why) => {
    if (dispatched) return;
    dispatched = true;
    console.log('[TeamDispatch] 触发发送 Worker 任务 (profile=' + profileId + ', 原因=' + (why || '') + ')');
    sendWorkerAgentPrompt(profileId).catch((e) => {
      console.error('[TeamDispatch] 发送 Worker 任务失败:', e.message);
    });
  };
  win.webContents.once('did-finish-load', () => fireOnce('did-finish-load'));
  try { win.webContents.once('dom-ready', () => fireOnce('dom-ready')); } catch (_) {}

  try {
    const provider = getProvider(ctx.providerId) || getProvider('deepseek');
    const homeUrl = provider && provider.homeUrl;
    if (homeUrl) {
      // 兼容多标签 webview 架构：webview 适配器没有 loadURL，统一走 webContents.loadURL
      await win.webContents.loadURL(homeUrl);
      // 超时兜底：5 秒后若仍未发送（URL 未变、事件未触发），强制发送
      setTimeout(() => fireOnce('timeout-5s'), 5000);
    } else {
      // 无 homeUrl：直接在当前会话发送
      fireOnce('no-homeUrl');
    }
  } catch (err) {
    pendingDispatches.delete(profileId);
    clearAckTimer(task.id);
    return { success: false, error: err.message };
  }

  return { success: true, taskId: task.id, mode: 'fresh' };
}

/**
 * 组装并发送 Worker 的「系统提示词 + 任务」
 */
async function sendWorkerAgentPrompt(profileId) {
  const pending = pendingDispatches.get(profileId);
  if (!pending) return;
  pendingDispatches.delete(profileId);

  const ctx = windowState.getWindowByProfileId(profileId);
  if (!ctx || !ctx.win || ctx.win.isDestroyed()) return;

  // 先绑定 taskId（页面加载后绑定，避免导航丢失）
  try {
    ctx.win.webContents.send('worker-bind-task', { taskId: pending.taskId });
  } catch (_) {}
  // 双向确认：发送绑定后启动等待 ack 的定时器，Worker 未在期限内确认则记录警告
  armAckTimer(pending.taskId, profileId);

  // 复用 initProject 组装完整系统提示词，并把任务合并进同一条初始提示
  try {
    const res = await initProject(false, ctx, pending.projectDir, pending.prompt);
    if (!res || res.success === false) {
      const reason = (res && res.message) || '初始化项目上下文失败';
      console.error('[TeamDispatch] 发送 Worker 任务失败:', reason);
      taskManager.updateTaskStatus(pending.taskId, 'FAILED', reason);
      try { require('./plan').markFailedByTaskId(pending.taskId, reason); } catch (_) {}
      try {
        require('./report-queue').enqueue({ taskId: pending.taskId, level: 'ASK', content: '派发给该 Worker 的任务未能发送（' + reason + '），请检查该 Worker 或换窗口重派。' });
      } catch (_) {}
      clearAckTimer(pending.taskId);
    }
  } catch (err) {
    console.error('[TeamDispatch] sendWorkerAgentPrompt 异常:', err.message);
    taskManager.updateTaskStatus(pending.taskId, 'FAILED', err.message);
    try { require('./plan').markFailedByTaskId(pending.taskId, err.message); } catch (_) {}
    clearAckTimer(pending.taskId);
  }
}

module.exports = { dispatchTask, clearAckTimer };
