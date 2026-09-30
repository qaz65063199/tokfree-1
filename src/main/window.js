/**
 * 窗口管理（多窗口 + 每窗口 profile 上下文）
 * 每个窗口关联一个 profileId，拥有独立的 sessionStore 实例。
 */
const windows = new Map(); // windowId -> { win, profileId, providerId, sessionStore }
let lastActiveWindowId = null;
// 壳窗口（多标签架构）的真实 BrowserWindow 引用。
// 多标签架构下每个标签是 webview（注册为适配器，且不更新 lastActiveWindowId），
// 壳窗口是唯一的真实 BrowserWindow；getMainWindow() 在无真实窗口指针时兜底返回它，
// 保证 dialog 等需要真实窗口的调用拿到合法 parent（否则 properties 会被忽略，弹成"文件选择框"）。
let shellWindow = null;

/** 把 webview 的 webContents 包装成"类 BrowserWindow"适配器（windowState 同时支持窗口与 webview） */
function makeWinAdapter(wc) {
  return {
    id: wc.id,
    webContents: wc,
    isDestroyed: () => wc.isDestroyed(),
    isMinimized: () => false,
    isFocused: () => { try { return wc.isFocused(); } catch (_) { return false; } },
    restore: () => {},
    focus: () => { try { wc.focus(); } catch (_) {} },
    minimize: () => {},
    setTitle: () => {},
    close: () => { try { wc.close(); } catch (_) {} },
    // webview 无独立任务栏，无法闪烁；任务栏闪烁请用壳窗口（windowState.getShellWindow()）。
    flashFrame: () => {},
    // webview 的 webContents 没有 'closed' 事件，用 'destroyed' 代替
    on: (ev, fn) => { try { wc.on(ev === 'closed' ? 'destroyed' : ev, fn); } catch (_) {} },
    once: (ev, fn) => { try { wc.once(ev === 'closed' ? 'destroyed' : ev, fn); } catch (_) {} },
  };
}

/** 内部：把（真实窗口或适配器）登记进 windows 表，并接线登录监测/关闭清理 */
function registerWindow(win, profileId, providerId, sessionStore, isRealWindow) {
  windows.set(win.id, { win, profileId, providerId, sessionStore });
  // 只有真实窗口才更新"主窗口"指针；webview 注册不应改变 getMainWindow() 的返回值
  // （否则对话框 parent / 窗口管理面板会拿到非 BrowserWindow 的适配器而失败）。
  if (isRealWindow) lastActiveWindowId = win.id;
  // 登录失效自动重登：持续监测（每 3 秒轮询登录页，SPA 内退出也能捕获）
  try {
    const loginManager = require('./login-manager');
    win.webContents.on('did-finish-load', () => {
      try { loginManager.scheduleCheck(profileId, 6000); } catch (_) {}
    });
    loginManager.startLoginWatcher(profileId);
  } catch (_) {}
  win.on('closed', () => {
    try { require('./login-manager').stopLoginWatcher(profileId); } catch (_) {}
    // 清除页面状态残留（窗口关闭后状态应为"未打开"，重开时 preload 会重新上报）
    try { require('./profile-manager').updateProfile(profileId, { pageState: '' }); } catch (_) {}
    // 多 Agent：该窗口若有进行中的子任务，标记为 FAILED（主大脑据此换 Worker 重派，不再干等）
    try {
      const tm = require('./team/task-manager');
      const active = tm.getActiveTaskByProfile(profileId);
      if (active) {
        tm.updateTaskStatus(active.id, 'FAILED', 'Worker 窗口已关闭');
        try { require('./team/plan').markFailedByTaskId(active.id, 'Worker 窗口已关闭'); } catch (_) {}
        try {
          const { enqueue } = require('./team/report-queue');
          enqueue({ taskId: active.id, level: 'ASK', content: 'Worker 窗口已关闭，任务中断，请换 Worker 重派或另行处理。' });
        } catch (_) {}
        console.log('[Window] Worker 窗口关闭，任务 ' + active.id + ' 标记 FAILED');
      }
    } catch (_) {}
    windows.delete(win.id);
    if (lastActiveWindowId === win.id) {
      const remaining = Array.from(windows.keys());
      lastActiveWindowId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
  });
}

/**
 * 注册一个真实 BrowserWindow（原有行为不变）。
 */
function addWindow(win, profileId, providerId, sessionStore) {
  registerWindow(win, profileId, providerId, sessionStore, true);
}

/**
 * 修复 3：注册一个 webview 的 webContents（多标签壳架构）。
 * webContents 不满足 BrowserWindow 接口，用适配器补齐 windowState 实际用到的成员，
 * 使 getContextByWebContents / getWindowByProfileId 对新旧两种都成立。
 * 注意：webview 注册不更新 lastActiveWindowId（getMainWindow 仍返回真实窗口）。
 */
function addWebviewWindow(webContents, profileId, providerId, sessionStore) {
  registerWindow(makeWinAdapter(webContents), profileId, providerId, sessionStore, false);
}

/**
 * 注册壳窗口（多标签架构唯一的真实 BrowserWindow）。
 * 只设置"主窗口"指针 + 保存引用，不做登录监测（壳窗口不是真实 profile，无登录页可轮询）。
 * 注册后 getMainWindow() 在无真实窗口指针时返回该壳窗口，使 dialog 的 parent 合法。
 */
function registerShellWindow(win) {
  if (!win) return;
  shellWindow = win;
  lastActiveWindowId = win.id;
  win.on('closed', () => {
    if (shellWindow === win) shellWindow = null;
    if (lastActiveWindowId === win.id) {
      const remaining = Array.from(windows.keys());
      lastActiveWindowId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
  });
}

function removeWindow(windowId) {
  windows.delete(windowId);
  if (lastActiveWindowId === windowId) {
    const remaining = Array.from(windows.keys());
    lastActiveWindowId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
  }
}

function getWindowContext(windowId) {
  return windows.get(windowId) || null;
}

function getContextByWebContents(webContents) {
  for (const ctx of windows.values()) {
    if (ctx.win.webContents === webContents) return ctx;
  }
  return null;
}

function getMainWindow() {
  if (!lastActiveWindowId) return null;
  const ctx = windows.get(lastActiveWindowId);
  if (ctx && ctx.win) return ctx.win;
  // 兜底：多标签架构下没有注册真实 BrowserWindow，返回壳窗口（真实 BrowserWindow）。
  if (shellWindow) {
    let destroyed = false;
    try { destroyed = !!(shellWindow.isDestroyed && shellWindow.isDestroyed()); } catch (_) {}
    if (!destroyed) return shellWindow;
  }
  return null;
}

function getMainContext() {
  if (!lastActiveWindowId) return null;
  return windows.get(lastActiveWindowId) || null;
}

function setMainWindow(win) {
  if (win) {
    lastActiveWindowId = win.id;
  } else {
    lastActiveWindowId = null;
  }
}

function getAllWindows() {
  return Array.from(windows.values()).map(ctx => ctx.win);
}

function getAllContexts() {
  return Array.from(windows.values());
}

function getWindowByProfileId(profileId) {
  for (const ctx of windows.values()) {
    if (ctx.profileId === profileId) return ctx;
  }
  return null;
}

/**
 * 取壳窗口（多标签架构唯一的真实 BrowserWindow）。
 * @returns {BrowserWindow|null}
 */
function getShellWindow() {
  if (!shellWindow) return null;
  let destroyed = false;
  try { destroyed = !!(shellWindow.isDestroyed && shellWindow.isDestroyed()); } catch (_) {}
  return destroyed ? null : shellWindow;
}

/**
 * 在壳窗口中以标签方式打开（或聚焦）指定 profile。
 * 壳窗口存在 → 发送 'shell-open-tab' 事件并返回 true；
 * 壳窗口不存在（旧多窗口模式 / 壳未创建）→ 返回 false，调用方回退 createWindow()。
 * @param {object} profile profile 对象（含 id/partition/providerId/name）
 * @param {object} [opts] { replace: 是否替换已有标签（切平台时用） }
 * @returns {boolean}
 */
function openProfileAsTab(profile, opts = {}) {
  const win = getShellWindow();
  if (!win || !profile || !profile.id) return false;
  let provider = null;
  try {
    const { getProvider } = require('../providers');
    provider = (profile.providerId && getProvider(profile.providerId)) || getProvider('deepseek');
  } catch (_) { /* providers 不可用（极端环境/测试）时用默认 URL */ }
  try {
    win.webContents.send('shell-open-tab', {
      type: opts.replace ? 'replace' : 'open',
      profileId: profile.id,
      partition: profile.partition,
      url: provider && provider.homeUrl ? provider.homeUrl : 'https://chat.deepseek.com/',
      name: profile.name,
      providerId: profile.providerId || (provider && provider.id) || 'deepseek',
    });
    // 聚焦壳窗口，让用户看到标签变化
    try { if (win.isMinimized()) win.restore(); win.focus(); } catch (_) {}
    return true;
  } catch (err) {
    console.error('[Window] openProfileAsTab 发送失败:', err && err.message);
    return false;
  }
}

/**
 * 在壳窗口中关闭指定 profile 的标签（删除窗口时联动）。
 * @param {string} profileId
 * @returns {boolean} 是否已发送（壳窗口不存在则 false）
 */
function closeProfileAsTab(profileId) {
  const win = getShellWindow();
  if (!win || !profileId) return false;
  try {
    win.webContents.send('shell-close-tab', { profileId });
    return true;
  } catch (err) {
    console.error('[Window] closeProfileAsTab 发送失败:', err && err.message);
    return false;
  }
}

module.exports = {
  addWindow,
  addWebviewWindow,
  registerShellWindow,
  removeWindow,
  getWindowContext,
  getContextByWebContents,
  getMainWindow,
  getMainContext,
  setMainWindow,
  getAllWindows,
  getAllContexts,
  getWindowByProfileId,
  getShellWindow,
  openProfileAsTab,
  closeProfileAsTab,
};
