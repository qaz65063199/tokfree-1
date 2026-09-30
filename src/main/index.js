/**
 * TokFree 主进程入口（多窗口多 profile 版）
 * 基于开源项目 Cuckoo Code 扩展，GPL-3.0
 * 由项目根目录 main.js 薄壳加载。
 */
const { app, BrowserWindow, Menu, dialog } = require('electron');
const { logger } = require('../core/logger');
// 程序名统一为 TokFree：影响系统通知、任务栏、Dock、菜单等显示名。
// 注意：此处仅设置应用名；数据目录随后由 app.setPath('userData', ...) 显式指定，不受影响。
app.setName('TokFree');
// Windows 系统通知/任务栏依赖 AppUserModelID：不设置时通知程序名会显示为 "Electron"
// （甚至被系统忽略不弹）。appId 与 package.json build.appId 保持一致。
if (process.platform === 'win32') {
  try {
    app.setAppUserModelId('com.tokfree.app');
  } catch (err) {
    logger.error('[TokFree] 设置 AppUserModelID 失败:', err && err.message);
  }
}
// 代理认证：当窗口配置的代理需要用户名/密码时，Electron 会触发 app 'login' 事件。
// 这里从对应窗口的 profile 配置里取凭证自动应答，避免弹出原生认证框。
app.on('login', (event, webContents, request, authInfo, callback) => {
  try {
    if (!authInfo || !authInfo.isProxy) return; // 只处理代理认证
    const ctx = require('./window').getContextByWebContents(webContents);
    if (!ctx) return;
    const pm = require('./profile-manager');
    const p = pm.getProfileById(ctx.profileId);
    if (p && p.proxy && p.proxy.enabled && p.proxy.username) {
      event.preventDefault();
      callback(p.proxy.username, p.proxy.password || '');
    }
  } catch (err) {
    logger.error('[TokFree] 代理认证处理失败:', err && err.message);
  }
});
const path = require('path');
const fs = require('fs');

// ========== GPU / 渲染后端兼容性 ==========
// 教训（重要）：曾为规避远程桌面/虚拟机下 GPU 进程崩溃而 disable-gpu，
// 但这会让 WebGL 完全不可用——而真实浏览器一定有 WebGL，
// 「无 WebGL」是极强的自动化特征，会导致 Google 登录/Cloudflare 判定"环境不安全"。
//
// 现在：默认启用 GPU；同时加 --enable-unsafe-swiftshader，让 GPU 不可用时
// Chromium 自动回退到软件 WebGL（SwiftShader），从而 WebGL 始终可用。
// 若个别环境仍因 GPU 崩溃，设环境变量 TOKFREE_DISABLE_GPU=1 回退硬禁用。
const forceDisableGpu = process.env.TOKFREE_DISABLE_GPU === '1';
if (forceDisableGpu) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  logger.warn('[TokFree] 已强制禁用 GPU（TOKFREE_DISABLE_GPU=1），WebGL 可能不可用，存在被识别风险');
} else {
  // 允许无 GPU 时回退软件 WebGL，保证 WebGL 可用
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('disable-gpu-sandbox');
// 反自动化：隐藏自动化控制标志（与 navigator.webdriver=false 呼应）
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

const windowState = require('./window');
const profileManager = require('./profile-manager');
const conversationStats = require('./conversation-stats');
const watchdog = require('./watchdog');
const { createSessionStore } = require('./session-store');
const { getProvider } = require('../providers');
const updater = require('./updater');

// ========== 持久化会话配置 ==========
const SESSION_DIR = process.env.TOKFREE_SESSION_DIR || 'tokfree-session';
const USER_DATA_DIR = path.join(app.getPath('appData'), SESSION_DIR);
// app.setPath('userData', ...) 要求目标目录必须已存在，否则会抛错导致启动闪退。
// 用户首次运行或手动删除该目录时，此处负责兜底创建。
try {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
} catch (err) {
  logger.error('[TokFree] 创建 userData 目录失败:', err.message);
}
app.setPath('userData', USER_DATA_DIR);
logger.info('[TokFree] Session 数据目录:', app.getPath('userData'));

// ========== Agent Runtime 端口注入 ==========
// 重构：src/main/team 下的模块不再直接依赖 electron，改为通过注入获取。
// 1) baseDir：统一 userData 基础目录，替代各模块 app.getPath('userData')。
const agentRuntimePaths = require('../core/agent-runtime/paths');
const agentRuntimeInject = require('../core/agent-runtime/inject');
agentRuntimePaths.setBaseDir(app.getPath('userData'));
// 2) injector：把「向 profile 窗口注入消息」收敛为回调，频道/格式保持不变。
agentRuntimeInject.setInjector((profileId, message) => {
  const ctx = windowState.getWindowByProfileId(profileId);
  if (ctx && ctx.win && !(ctx.win.isDestroyed && ctx.win.isDestroyed())) {
    ctx.win.webContents.send('master-inject-message', { message });
  }
});

// 渲染进程日志输出目录（仅开发环境持久化；打包版不写日志文件）
const RENDERER_LOG_DIR = app.isPackaged
  ? null
  : path.join(app.getPath('userData'), 'wyp', 'log');
if (RENDERER_LOG_DIR) {
  fs.mkdirSync(RENDERER_LOG_DIR, { recursive: true });
  // 日志轮转：归档旧日志（保留最近 5 个带时间戳的），而不是清空
  try {
    const KEEP = 5;
    for (const f of fs.readdirSync(RENDERER_LOG_DIR)) {
      if (!f.endsWith('.log') || /-\d{4}-\d{2}-\d{2}T/.test(f)) continue;
      const cur = path.join(RENDERER_LOG_DIR, f);
      try {
        const st = fs.statSync(cur);
        if (st.size > 0) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const base = f.replace(/\.log$/, '');
          fs.renameSync(cur, path.join(RENDERER_LOG_DIR, base + '-' + ts + '.log'));
        }
      } catch (_) {}
    }
    const archives = fs.readdirSync(RENDERER_LOG_DIR)
      .filter(f => /-\d{4}-\d{2}-\d{2}T.*\.log$/.test(f))
      .map(f => ({ f, t: fs.statSync(path.join(RENDERER_LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (let i = KEEP * 3; i < archives.length; i++) {
      try { fs.unlinkSync(path.join(RENDERER_LOG_DIR, archives[i].f)); } catch (_) {}
    }
  } catch (err) {
    logger.warn('[TokFree] 平台日志轮转失败:', err.message);
  }
}

const { registerIpcHandlers } = require('./ipc');

// 退出前需要 flush 的 sessions
const sessionsToFlush = new Set();

async function flushAllSessions() {
  const promises = [];
  for (const ses of sessionsToFlush) {
    promises.push(ses.flushStorageData().catch(err => {
      logger.error('[TokFree] 刷新 session 失败:', err.message);
    }));
  }
  await Promise.all(promises);
  logger.info('[TokFree] 全部 session 数据已刷新到磁盘');
}

/**
 * 品牌图标（TF）。
 * 开发态直接引用 build/icon.ico；打包后 build/ 被 package.json files 的 "!build" 排除，
 * 此处回退为 undefined，窗口自动沿用可执行文件内嵌图标（由 electron-builder 从同一文件写入）。
 */
const APP_ICON_PATH = (function () {
  try {
    const p = path.join(__dirname, '..', '..', 'build', 'icon.ico');
    return require('fs').existsSync(p) ? p : undefined;
  } catch (_) {
    return undefined;
  }
})();

/**
 * 创建窗口（绑定指定 profile）
 * @param {object|null} profile profile 对象，null 则使用默认 profile
 * @param {object} [opts] 选项；opts.minimized=true 时以最小化方式打开（不抢焦点，
 *   避免盖住调用方窗口的「窗口管理」面板，便于连续打开多个窗口）
 */
async function createWindow(profile, opts) {
  const startMinimized = !!(opts && opts.minimized);
  const profileData = profile || profileManager.getDefaultProfile();
  const provider = getProvider(profileData.providerId || 'deepseek') || getProvider('deepseek');
  const storeDir = app.getPath('userData');
  const sessionStore = createSessionStore(profileData.id, storeDir, windowState);
  const hasExplicitProfile = !!profile;
  // providerId 已确定 → 直接打开；未确定 → 显示平台选择页
  const providerChosen = !!profileData.providerId;

  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,                 // 品牌启动：ready-to-show 后再显示（消除白闪）
    backgroundColor: '#0e0f1a',  // 品牌深色底，避免加载白屏
    title: 'TokFree - ' + provider.name + ' - ' + profileData.name,
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: profileData.partition, // 每个 profile 独立持久化 session
      backgroundThrottling: false,
      additionalArguments: [
        '--tokfree-user-data=' + app.getPath('userData'),
        '--tokfree-theme=' + require('./settings').getTheme(),
        // 指纹配置（base64），preload 读取后在主世界注入
        '--tokfree-fingerprint=' + Buffer.from(JSON.stringify(profileData.fingerprint || { enabled: false })).toString('base64'),
      ],
    },
  });

  // 恢复上次窗口大小/位置（无记录时保持默认，show 时会最大化）
  let savedMaximized = null;
  try { savedMaximized = require('./window-bounds').apply(mainWindow, profileData.id); } catch (_) {}

  // 保存 session 引用（窗口销毁后 webContents 不可访问）
  const winSession = mainWindow.webContents.session;

  // 浏览器兼容：同步 Sec-CH-UA 请求头与 JS 层（补 Google Chrome 品牌），
  // 并对齐 Accept-Language（跟随指纹语言，避免请求头与 navigator.languages 矛盾）
  try {
    const fpEnabled = !!(profileData.fingerprint && profileData.fingerprint.enabled);
    const fpLang = fpEnabled ? (profileData.fingerprint.language || '') : '';
    const fpOs = fpEnabled ? (profileData.fingerprint.os || '') : '';
    require('./browser-compat').applyHeaderFix(winSession, { language: fpLang, os: fpOs });
  } catch (err) {
    logger.error('[TokFree] 请求头修正失败:', err && err.message);
  }

  // 注册窗口上下文（记录 providerId，未确定时为空字符串）
  windowState.addWindow(mainWindow, profileData.id, profileData.providerId || '', sessionStore);
  // 崩溃捕获：该窗口 webContents 无响应/恢复时记日志
  try { attachUnresponsiveLogging(mainWindow.webContents, profileData.id); } catch (_) {}
  windowState.createWindow = createWindow;
  sessionsToFlush.add(winSession);

  // 更新主窗口引用
  windowState.setMainWindow(mainWindow);

  // 初始化自动更新（仅第一个窗口时初始化）
  if (windowState.getAllWindows().length === 1) {
    updater.initAutoUpdater(mainWindow);
  }

  // 转发渲染进程的 console.log 到主进程，并按平台写入独立日志文件
  mainWindow.webContents.on('console-message', (_event, level, message, _line, _sourceId) => {
    logger.info('[Renderer Console][' + profileData.name + ']', message);

    // 打包版不进行日志持久化
    if (!RENDERER_LOG_DIR) return;

    // 根据当前窗口上下文确定 providerId，未确定用 default
    let providerId = profileData.providerId || 'default';
    const ctx = windowState.getContextByWebContents(mainWindow.webContents);
    if (ctx && ctx.providerId) providerId = ctx.providerId;

    const logFile = path.join(RENDERER_LOG_DIR, providerId + '.log');
    const timeIso = new Date().toISOString();
    fs.appendFileSync(logFile, '[' + timeIso + '][' + profileData.name + '] ' + message + '\n', 'utf-8');
  });

  // 品牌启动：ready-to-show 后再显示（消除加载白闪）。
  let __shown = false;
  const __doShow = function () {
    if (__shown || mainWindow.isDestroyed()) return;
    __shown = true;
    // 有历史记录且非最大化 → 保持恢复出的 bounds；否则默认最大化
    if (savedMaximized !== false) mainWindow.maximize();
    if (startMinimized) {
      mainWindow.minimize();
    }
  };
  mainWindow.once('ready-to-show', __doShow);
  setTimeout(__doShow, 3000);

  // 设置与 Electron 33（Chromium 130）匹配的普通 Chrome UA。
  // 关键：UA 必须与指纹伪装的操作系统一致，否则 navigator.platform / userAgentData /
  // WebGL 渲染器 / UA 四者互相矛盾，会被反爬系统判定为机器人并返回空白页。
  const fpOs = (profileData.fingerprint && profileData.fingerprint.enabled)
    ? (profileData.fingerprint.os || '')
    : '';
  let userAgent;
  if (fpOs === 'mac') {
    userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  } else if (fpOs === 'linux') {
    userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  } else {
    // 默认 / 跟随系统 / win：Windows UA
    userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  }
  mainWindow.webContents.setUserAgent(userAgent);

  // 指纹伪装：默认走 preload 注入（稳定）。
  // CDP 注入（Page.addScriptToEvaluateOnNewDocument）更隐蔽，但 attach debugger 有副作用
  // （无法开 DevTools，个别环境干扰页面加载），故改为显式开启：设置环境变量 TOKFREE_FP_CDP=1。
  if (profileData.fingerprint && profileData.fingerprint.enabled && process.env.TOKFREE_FP_CDP === '1') {
    try {
      const { applyFingerprintCdp } = require('./fingerprint-cdp');
      await applyFingerprintCdp(mainWindow.webContents, profileData.fingerprint);
    } catch (err) {
      logger.error('[TokFree] CDP 指纹注入失败:', err && err.message);
    }
  }

  // 应用该窗口的独立代理（若有），必须在 loadURL 前完成
  try {
    const proxyMgr = require('./proxy');
    if (profileData.proxy && profileData.proxy.enabled) {
      await proxyMgr.applyProxy(winSession, profileData.proxy);
    }
  } catch (err) {
    logger.error('[TokFree] 应用代理失败:', err && err.message);
  }

  if (providerChosen) {
    // 平台已确定，直接进入平台首页
    mainWindow.loadURL(provider.homeUrl);
  } else {
    // 平台未确定，显示平台选择页
    const selectPage = path.join(__dirname, '..', 'ui', 'platform-select.html');
    mainWindow.loadFile(selectPage);
  }

  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('page-loaded');
      sessionStore.tryRestoreSessionFromUrl(mainWindow);
    }
  });

  mainWindow.webContents.on('did-navigate', (_event, url) => {
    sessionStore.handleUrlChange(url, mainWindow);
  });

  mainWindow.webContents.on('did-navigate-in-page', (_event, url) => {
    sessionStore.handleUrlChange(url, mainWindow);
  });

  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.on('close', () => {
    try {
      const b = require('./window-bounds').capture(mainWindow);
      if (b) require('./window-bounds').save(profileData.id, b);
    } catch (_) {}
  });

  mainWindow.on('closed', () => {
    sessionsToFlush.delete(winSession);
    windowState.removeWindow(mainWindow.id);
    watchdog.forget(profileData.id);
  });
}

/**
 * 构造与 Electron 33（Chromium 130）匹配的普通 Chrome UA。
 *
 * 关键：UA 必须与指纹伪装的操作系统一致，否则 navigator.platform / userAgentData /
 * WebGL 渲染器 / UA 四者互相矛盾，会被反爬系统判定为机器人并返回空白页。
 * 默认（无指纹 / win / 跟随系统）返回 Windows UA。
 *
 * @param {object|null} profileData profile 对象（读 fingerprint.os）
 * @returns {string} Chrome 130 UA
 */
function buildChromeUserAgent(profileData) {
  const fpOs = (profileData && profileData.fingerprint && profileData.fingerprint.enabled)
    ? (profileData.fingerprint.os || '')
    : '';
  if (fpOs === 'mac') {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  }
  if (fpOs === 'linux') {
    return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  }
  // 默认 / 跟随系统 / win：Windows UA
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
}

// ========== 壳窗口（TokFree 多标签） ==========
// 新架构：一个窗口 = 多个标签页，每个标签内嵌一个独立 partition 的 DeepSeek 实例。
// 保留 createWindow（旧多窗口模式）以兼容。
async function createShellWindow() {
  // 修复 1：Windows 下 file URL 需三斜杠（file:///C:/...）。
  // 原写法 'file://' + 'C:/...' 产生 'file://C:/...'（错误，webview preload 加载失败）。
  // 用 pathToFileURL 最稳，自动处理盘符与转义。
  const webviewPreloadPath = require('url').pathToFileURL(
    path.join(__dirname, '..', '..', 'preload.js')
  ).href;
  const shellPreloadPath = path.join(__dirname, '..', 'preload', 'shell-preload.js');
  const shellHtmlPath = path.join(__dirname, '..', 'ui', 'shell.html');

  const shellWin = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#0e0f1a',
    title: 'TokFree',
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: shellPreloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,             // 关键：允许 <webview> 标签
      backgroundThrottling: false,
      additionalArguments: [
        // 把 webview 需要挂载的 preload 绝对路径（file://）传给壳 preload
        '--tokfree-webview-preload=' + encodeURIComponent(webviewPreloadPath),
      ],
    },
  });

  // 恢复上次窗口大小/位置（无记录时保持默认，show 时会最大化）
  let shellSavedMaximized = null;
  try { shellSavedMaximized = require('./window-bounds').apply(shellWin, '__shell__'); } catch (_) {}

  // 品牌启动：ready-to-show 后再显示
  let __shown = false;
  const __doShow = function () {
    if (__shown || shellWin.isDestroyed()) return;
    __shown = true;
    // 有历史记录且非最大化 → 保持恢复出的 bounds；否则默认最大化
    if (shellSavedMaximized !== false) shellWin.maximize();
  };
  shellWin.once('ready-to-show', __doShow);
  setTimeout(__doShow, 3000);

  // 反检测（双保险）：壳窗口自身也设普通 Chrome UA。
  // 注意：webview 是独立的 webContents，不继承壳窗口 UA，
  // 真正的关键修复在下方 did-attach-webview 里对每个 webview 单独 setUserAgent。
  try {
    shellWin.webContents.setUserAgent(buildChromeUserAgent(null));
  } catch (err) {
    logger.error('[TokFree] 壳窗口 setUserAgent 失败:', err && err.message);
  }
  shellWin.webContents.on('console-message', (_event, _level, message) => {
    logger.info('[Shell Console]', message);
  });

  shellWin.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') {
      shellWin.webContents.toggleDevTools();
      return;
    }
    // 菜单栏已移除：标签快捷键改由壳窗口级拦截（Ctrl+T 新标签 / Ctrl+W 关标签）
    if (input.control && (input.key === 't' || input.key === 'T')) {
      try { shellWin.webContents.send('shell-shortcut', 'new-tab'); } catch (_) {}
      return;
    }
    if (input.control && (input.key === 'w' || input.key === 'W')) {
      try { shellWin.webContents.send('shell-shortcut', 'close-tab'); } catch (_) {}
    }
  });

  shellWin.on('close', () => {
    try {
      const b = require('./window-bounds').capture(shellWin);
      if (b) require('./window-bounds').save('__shell__', b);
    } catch (_) {}
  });

  shellWin.on('closed', () => {
    logger.info('[TokFree] 壳窗口已关闭');
  });

  // 修复：把壳窗口注册进 windowState。
  // 多标签架构下每个标签是 webview（注册为适配器，不更新主窗口指针），
  // 壳窗口是唯一的真实 BrowserWindow。注册后 getMainWindow() 才能返回合法 BrowserWindow，
  // 供 dialog（目录选择框的 parent）等需要真实窗口的调用使用——
  // 否则 parent 为 null/适配器，dialog 会忽略 properties，把"文件夹选择框"弹成"文件选择框"。
  windowState.registerShellWindow(shellWin);
  // 崩溃捕获：壳窗口自身 webContents 无响应/恢复
  try { attachUnresponsiveLogging(shellWin.webContents, '__shell__'); } catch (_) {}

  // 自动更新：旧多窗口路径在 createWindow 里初始化，壳窗口路径同样需要（菜单栏已移除，改为后台自动检查）
  try { updater.initAutoUpdater(shellWin); } catch (err) {
    logger.warn('[TokFree] 自动更新初始化失败（壳窗口）:', err && err.message);
  }

  // ========== 修复 3（核心）：让主进程认识 webview ==========
  // 每个标签 = 一个 <webview>，其 webContents 是独立渲染进程。
  // 覆盖层/工具/看门狗都通过 event.sender(webContents) 反查窗口上下文，
  // 因此必须把 webview 的 webContents 注册进 windowState，否则所有 IPC 找不到归属 → 按钮全失效。
  //
  // 映射方案（约定）：shell.js 先调 'create-tab-profile' 拿到一个 profile，
  // 其 partition 形如 'persist:<profileId>'，再把它设成 webview 的 partition 属性。
  // 于是 did-attach-webview 里用 guestWebContents.session.getStoragePath() 的末段
  // （= <profileId>）即可反查同一个 profile，二者严格一致。
  shellWin.webContents.on('did-attach-webview', (_event, guestWebContents) => {
    try {
      // partition 名 = 存储目录末段（persist:<name> → <name>）。
      // 约定：shell.js 用 create-tab-profile 拿到的 partition 就是 'persist:<profileId>'，
      // 故 <name> 即 profileId。为稳妥，再按 profile.partition 兜底匹配一次。
      let profile = null;
      let profileId = '';
      try {
        const storePath = guestWebContents.session.getStoragePath();
        if (storePath) profileId = path.basename(storePath);
      } catch (_) {}
      if (profileId) {
        profile = profileManager.getProfileById(profileId);
        if (!profile) {
          // 加固反查：profile.id 由 'profile-<时间戳>-<随机>' 组成，天然是文件系统安全字符，
          // 无论 partition 前缀（persist:deepseek:xxx）被 Electron 如何 sanitize，
          // 存储目录名里必然包含 profile.id。
          profile = profileManager.readProfiles().find(function (p) {
            return p.id && profileId.indexOf(p.id) !== -1;
          }) || null;
        }
        if (!profile) {
          // 兜底：按 partition 后缀匹配（应对存储目录名被 sanitize 的情况）
          profile = profileManager.readProfiles().find(function (p) {
            return p.partition && p.partition.indexOf(profileId) !== -1;
          }) || null;
        }
      }
      if (!profile) {
        logger.warn('[TokFree] webview 未找到对应 profile（profileId=' + (profileId || '(空)') + '），跳过注册');
        return;
      }

      // ========== 反检测（核心修复）：webview 是独立 webContents，默认用 Electron UA（含 "Electron/33"），
      // 会被 DeepSeek 识别为机器人并弹「使用环境异常 / 数据隐私泄露风险」。
      // 旧 createWindow 路径做了 setUserAgent + applyHeaderFix，壳窗口路径漏做，这里补齐：
      //   1) setUserAgent 伪装成普通 Chrome（跟随指纹 os，默认 win，与旧路径一致）；
      //   2) 对 webview 的独立 session（partition=persist:<profileId>）应用请求头修正，
      //      把 Sec-CH-UA 补成 "Google Chrome"，与 JS 层 navigator.userAgentData 一致，
      //      避免「请求头 vs JS 读数」矛盾被检测。
      // applyHeaderFix 内部用 WeakSet 做幂等，天然防重复应用。
      try {
        guestWebContents.setUserAgent(buildChromeUserAgent(profile));
        logger.info('[TokFree] webview UA 已伪装 profile=' + profile.id);
      } catch (err) {
        logger.error('[TokFree] webview setUserAgent 失败:', err && err.message);
      }
      try {
        // 与指纹对齐：语言与 os 都要传，否则 Sec-CH-UA-Platform / Accept-Language
        // 与 JS 层 navigator.userAgentData.platform / navigator.language 矛盾 → 被判机器人。
        const fpEnabled = !!(profile.fingerprint && profile.fingerprint.enabled);
        const fpLang = fpEnabled ? (profile.fingerprint.language || '') : '';
        const fpOs = fpEnabled ? (profile.fingerprint.os || '') : '';
        require('./browser-compat').applyHeaderFix(guestWebContents.session, { language: fpLang, os: fpOs });
      } catch (err) {
        logger.error('[TokFree] webview 请求头修正失败:', err && err.message);
      }
      const storeDir = app.getPath('userData');
      const sessionStore = createSessionStore(profile.id, storeDir, windowState);
      // 用专用入口注册 webview（webContents 适配为类窗口对象）
      windowState.addWebviewWindow(guestWebContents, profile.id, profile.providerId || '', sessionStore);
      // 崩溃捕获：该 webview（标签）无响应/恢复时记日志（带 profileId）
      try { attachUnresponsiveLogging(guestWebContents, profile.id); } catch (_) {}
      logger.info('[TokFree] webview 已注册 profile=' + profile.id + ' wcId=' + guestWebContents.id);

      // 会话/URL 变化 → 更新 sessionStore（与普通窗口一致的接线）
      // ⚠️ targetWindow 必须传本 webview 的适配器：传 null 会兜底到 getMainWindow()
      // （= 壳窗口），project-dir-updated / session-restored 事件全部发错地方——
      // 已初始化的会话页收不到目录恢复事件，误弹「初始化项目」提示。
      const wvCtx = windowState.getWindowByProfileId(profile.id);
      const wvWin = wvCtx ? wvCtx.win : null;
      guestWebContents.on('did-navigate', (_e, url) => { try { sessionStore.handleUrlChange(url, wvWin); } catch (_) {} });
      guestWebContents.on('did-navigate-in-page', (_e, url) => { try { sessionStore.handleUrlChange(url, wvWin); } catch (_) {} });
      // 注册时若已停在会话页（如恢复的标签），立即按当前 URL 恢复目录状态，
      // 不必等下一次导航事件。
      try { if (wvWin) sessionStore.tryRestoreSessionFromUrl(wvWin); } catch (_) {}
      // webview 的 console 转发到主进程日志
      guestWebContents.on('console-message', (_e, _lvl, message) => {
        logger.info('[Webview Console][' + profile.id + ']', message);
      });
    } catch (err) {
      logger.error('[TokFree] 注册 webview 失败:', err && err.message);
    }
  });

  await shellWin.loadFile(shellHtmlPath);
  logger.info('[TokFree] 壳窗口已创建（webviewTag + 多标签）');
  return shellWin;
}

// ========== 应用菜单 ==========
function setupAppMenu() {
  // 商业化改版：去掉系统菜单栏（文件/编辑/导航/查看/窗口/帮助），
  // 所有能力收口到壳层左右侧栏与标签体系。
  // F12 开发者工具仍可用（窗口级 before-input-event 拦截），
  // 复制/粘贴/撤销等编辑快捷键由 webview 内页面原生处理，不依赖应用菜单。
  Menu.setApplicationMenu(null);
}

// ========== 崩溃 / 异常捕获（诊断闪退：确保崩了留痕） ==========
// 背景：本应用此前无任何崩溃监听，renderer/GPU 进程崩溃时不写日志，闪退无法定位。
// 这里挂全局监听，把崩溃/无响应统一以 [Crash] 前缀写入日志（含 profileId，便于定位是哪个窗口崩的）。
// 全 try/catch：诊断代码绝不能反过来影响主流程。
function resolveProfileByWC(wc) {
  try {
    const ctx = windowState.getContextByWebContents(wc);
    return ctx ? ctx.profileId : '(未知)';
  } catch (_) { return '(未知)'; }
}

// 给单个 webContents 挂「无响应 / 已恢复」监听（幂等）
function attachUnresponsiveLogging(wc, profileId) {
  try {
    if (!wc || wc.__crashUnresponsiveHooked) return;
    wc.__crashUnresponsiveHooked = true;
    wc.on('unresponsive', () => {
      try { logger.warn('[Crash] 窗口无响应(unresponsive) profile=' + (profileId || '(未知)') + ' wcId=' + wc.id); } catch (_) {}
    });
    wc.on('responsive', () => {
      try { logger.info('[Crash] 窗口已恢复响应(responsive) profile=' + (profileId || '(未知)') + ' wcId=' + wc.id); } catch (_) {}
    });
  } catch (_) {}
}

try {
  // 1) 渲染进程崩溃/被杀/OOM：reason = crashed/oom/killed/abnormal-exit/launch-failed/...
  app.on('render-process-gone', (_event, webContents, details) => {
    try {
      const d = details || {};
      logger.warn('[Crash] render-process-gone profile=' + resolveProfileByWC(webContents) +
        ' wcId=' + (webContents && webContents.id) +
        ' reason=' + d.reason + ' exitCode=' + d.exitCode);
    } catch (_) {}
  });

  // 2) 子进程崩溃（GPU / Utility / Network / ...）
  app.on('child-process-gone', (_event, details) => {
    try {
      const d = details || {};
      logger.warn('[Crash] child-process-gone type=' + d.type +
        ' reason=' + d.reason + ' exitCode=' + d.exitCode +
        ' name=' + (d.name || '') + ' serviceName=' + (d.serviceName || ''));
    } catch (_) {}
  });

  // 3) GPU 进程崩溃（旧事件，新版已并入 child-process-gone；保留以兼容）
  app.on('gpu-process-crashed', (_event, killed) => {
    try { logger.warn('[Crash] gpu-process-crashed killed=' + killed); } catch (_) {}
  });

  // 4) 本地崩溃转储（不上报）：crashDumps 目录 + crashReporter
  try {
    const crashDumpsDir = path.join(app.getPath('userData'), 'crashDumps');
    fs.mkdirSync(crashDumpsDir, { recursive: true });
    app.setPath('crashDumps', crashDumpsDir);
    const { crashReporter } = require('electron');
    crashReporter.start({ companyName: 'TokFree', productName: 'TokFree', submitURL: '', uploadToServer: false, compress: false });
    logger.info('[Crash] 本地崩溃捕获已启用，dump 目录: ' + crashDumpsDir);
  } catch (err) {
    logger.warn('[Crash] crashReporter 初始化失败（已忽略）:', err && err.message);
  }
} catch (err) {
  logger.error('[Crash] 崩溃监听注册失败:', err && err.message);
}

// ========== IPC 处理器 ==========
registerIpcHandlers();

// 启动收件队列（主大脑的多子 Agent 回报排队/合并/唤醒）
try {
  require('./team/report-queue').start();
  logger.info('[TokFree] 收件队列已启动');
} catch (err) {
  logger.error('[TokFree] 收件队列启动失败:', err.message);
}

// 启动编排调度器（保证 Manager 持续决策：催派活/催验收/催处理卡住）
try {
  require('./team/scheduler').start();
  logger.info('[TokFree] 编排调度器已启动');
} catch (err) {
  logger.error('[TokFree] 编排调度器启动失败:', err.message);
}

// 启动自驱循环驱动器（无人干预持续进化：定期推进运行中的目标）
try {
  require('./team/self-loop-driver').start();
  logger.info('[TokFree] 自驱循环驱动器已启动');
} catch (err) {
  logger.error('[TokFree] 自驱循环驱动器启动失败:', err.message);
}

// 启动技能库自维护调度器（每24小时：淘汰低效技能 + 生成优化建议）
try {
  require('./team/auto-evolve').startScheduler();
  logger.info('[TokFree] 技能库自维护调度器已启动');
} catch (err) {
  logger.error('[TokFree] 技能库自维护调度器启动失败:', err.message);
}

// 启动引导者驱动器（战略巡检秘书：空闲时采集项目现状并注入战略思考简报）
try {
  require('./team/curator').start();
  logger.info('[TokFree] 引导者驱动器已启动');
} catch (err) {
  logger.error('[TokFree] 引导者驱动器启动失败:', err.message);
}

// 启动定时任务模块（用户可管理的轻量定时注入）
try {
  require('./scheduled-tasks').start();
  logger.info('[TokFree] 定时任务模块已启动');
} catch (err) {
  logger.error('[TokFree] 定时任务模块启动失败:', err.message);
}

// 进化飞轮 SOP 技能 seed（幂等）：确保 evolution-flywheel 技能存在且全局启用，
// 每次飞轮触发时强制 AI 先读它、按固定 SOP 执行。
try {
  require('./team/flywheel-skill').seedSkill();
  logger.info('[TokFree] 进化飞轮 SOP 技能已就绪');
} catch (e) {
  logger.error('[TokFree] 飞轮 SOP 技能 seed 失败:', e.message);
}

// 老目标数据迁移（幂等）：把无 projectDir 的历史跨项目目标标记 legacy，避免继续污染巡检简报。
try {
  const m = require('./team/self-loop').migrateLegacyGoals();
  if (m && m.migrated > 0) logger.info('[TokFree] 老目标数据迁移完成：标记 legacy ' + m.migrated + ' 条（共 ' + m.total + ' 条）');
} catch (e) {
  logger.error('[TokFree] 老目标数据迁移失败:', e.message);
}

// 注册「编排中」钩子：主大脑有活跃子任务时，看门狗不催它"完成确认"
try {
  const watchdog = require('./watchdog');
  const planManager = require('./team/plan');
  watchdog.setActiveOrchestrationCheck(function (profileId) {
    try {
      if (!profileId) return false;
      // 该 profile 有未完成的编排计划 → 视为编排中
      const plan = planManager.getPlan(profileId);
      if (!plan) return false;
      planManager.refresh(plan);
      const allDone = plan.modules.length > 0 && plan.modules.every(function (m) {
        return m.status === 'done' || m.status === 'skipped';
      });
      return !allDone;
    } catch (_) { return false; }
  });
  logger.info('[TokFree] 编排中检查钩子已注册');
} catch (err) {
  logger.error('[TokFree] 编排钩子注册失败:', err.message);
}

const { ipcMain: ipcMainForProfile } = require('electron');

// ========== 修复 3（核心）配套：为壳层新标签创建 profile ==========
// 每个 <webview> 需要一个独立 partition + profile，主进程才能在 did-attach-webview
// 时把 webContents 注册进 windowState。partition 命名固定为 'persist:<profileId>'，
// 主进程据 session 存储路径末段反查 profileId，二者严格一致。
ipcMainForProfile.handle('create-tab-profile', async (_event, { name, providerId } = {}) => {
  try {
    const profiles = profileManager.readProfiles();
    // 标签页默认绑定 deepseek（壳层加载的就是 DeepSeek 首页）：
    // 1) team-list-workers / 多 Agent 体系按 providerId 识别可用 Worker；
    // 2) did-attach-webview 注册反查已加固为「存储路径包含 profile.id 即匹配」，
    //    不再受 partition 前缀（persist:deepseek:xxx）的字符 sanitize 影响。
    const profile = profileManager.createProfile(name || ('标签' + (profiles.length + 1)), providerId || 'deepseek');
    // 反检测：返回与 profile 指纹一致的 Chrome UA，供壳层在 <webview> 上【同步】设置 useragent 属性。
    // 关键：仅靠 did-attach-webview 异步 setUserAgent 存在竞态——webview 的首个请求
    // 可能早于 UA 设置发出，短暂泄漏 "Electron/33" UA，被 DeepSeek 反爬识别为机器人。
    let ua = '';
    try { ua = buildChromeUserAgent(profile); } catch (_) { ua = ''; }
    return { success: true, profileId: profile.id, partition: profile.partition, userAgent: ua };
  } catch (err) {
    logger.error('[TokFree] 创建标签 profile 失败:', err && err.message);
    return { success: false, error: err.message };
  }
});

// 壳窗口信息查询（打包状态等，供壳层按环境裁剪临时调试功能）
ipcMainForProfile.handle('shell:get-info', async () => {
  return { success: true, isPackaged: app.isPackaged, version: app.getVersion() };
});

// 覆盖层"新建窗口"按钮触发 → 壳窗口内开新标签（不再弹新 BrowserWindow）
ipcMainForProfile.handle('create-profile-window', async (_event, { providerId } = {}) => {
  const profiles = profileManager.readProfiles();
  const pid = providerId || '';
  const profile = profileManager.createProfile('标签' + (profiles.length + 1), pid);
  if (!windowState.openProfileAsTab(profile)) {
    // 壳窗口不可用（旧多窗口模式）→ 回退创建真实窗口
    createWindow(profile).catch(e => logger.error('[TokFree] createWindow 失败:', e && e.message));
  }
  return { success: true };
});

// 列出所有 profiles（附带今日收发计数）
ipcMainForProfile.handle('list-profiles', async () => {
  const profiles = profileManager.readProfiles();
  const withStats = profiles.map(p => {
    const today = conversationStats.getToday(p.id);
    return { ...p, todaySent: today.sent, todayReceived: today.received };
  });
  return { success: true, profiles: withStats };
});

// 删除指定 profile（会关闭其窗口）
ipcMainForProfile.handle('delete-profile', async (_event, { profileId }) => {
  if (!profileId) return { success: false, error: '缺少窗口ID' };
  // 联动关闭壳窗口里对应的标签页（多标签架构下 webview 由 shell.js 管理，
  // 主进程直接 close 适配器不会同步 shell 的 tabs 数组与 DOM，必须发事件通知）。
  try { windowState.closeProfileAsTab(profileId); } catch (e) { logger.warn('[TokFree] closeProfileAsTab 失败:', e.message); }
  const ctx = windowState.getWindowByProfileId(profileId);
  if (ctx && ctx.win && !ctx.win.isDestroyed()) {
    ctx.win.close();
  }
  const ok = profileManager.deleteProfile(profileId);
  // 删 profile 后清理其磁盘数据（partition 目录 + session 映射），避免残留几百 MB
  if (ok) {
    try {
      const cleanup = require('./cleanup');
      // 窗口刚 close，partition 可能还被占用：延迟 1.5 秒再删
      setTimeout(() => {
        cleanup.cleanupProfileData(profileId).then(r => {
          if (r && r.removed.length) {
            logger.info('[TokFree] 已清理 profile 磁盘数据：' + r.removed.join(', ') + '，释放 ' + (r.freedBytes / 1024 / 1024).toFixed(2) + ' MB');
          }
        }).catch(e => logger.warn('[TokFree] 清理 profile 数据失败:', e && e.message));
      }, 1500);
    } catch (e) { logger.warn('[TokFree] 清理 profile 数据失败:', e.message); }
  }
  return { success: ok, error: ok ? null : '窗口不存在' };
});

// 列出所有内置平台
ipcMainForProfile.handle('list-providers', async () => {
  const { getAllProviders } = require('../providers');
  return {
    success: true,
    providers: getAllProviders().map(p => ({
      id: p.id,
      name: p.name,
      custom: !!p._customPath,
      path: p._customPath || null,
      homeUrl: (typeof p.homeUrl === 'string' ? p.homeUrl : (p.homeUrl || null)),
    })),
  };
});

// 导入自定义 Provider（弹文件选择框，复制到 userData，并处理重名）
ipcMainForProfile.handle('import-provider', async (event, { replace = false } = {}) => {
  const win = windowState.getMainWindow();
  const result = dialog.showOpenDialogSync(win, {
    properties: ['openFile'],
    filters: [{ name: 'JavaScript', extensions: ['js'] }],
    title: '选择自定义 Provider 文件',
  });
  if (!result || result.length === 0) {
    return { success: false, canceled: true };
  }

  const filePath = result[0];
  const { importCustomProvider } = require('../providers/custom/loader');
  try {
    const res = importCustomProvider(filePath, { replace });
    if (res.exists && !replace) {
      // 同名 provider 已存在，询问是否替换
      const confirmRes = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['取消', '替换'],
        defaultId: 0,
        cancelId: 0,
        title: 'Provider 已存在',
        message: '已导入过 id 为 "' + res.provider.id + '" 的 Provider，是否替换？',
      });
      if (confirmRes.response !== 1) {
        return { success: false, canceled: true };
      }
      // 用户确认替换，重新导入
      const finalRes = importCustomProvider(filePath, { replace: true });
      return { success: true, provider: { id: finalRes.provider.id, name: finalRes.provider.name, path: finalRes.targetPath } };
    }
    return { success: true, provider: { id: res.provider.id, name: res.provider.name, path: res.targetPath } };
  } catch (err) {
    return { success: false, error: '加载失败: ' + err.message };
  }
});

// 删除自定义 Provider（先检查是否有窗口在使用）
ipcMainForProfile.handle('remove-provider', async (_event, { path: filePath, providerId }) => {
  if (!filePath) return { success: false, error: '缺少文件路径' };

  // 检查是否有窗口正在使用该 provider
  const usingContexts = windowState.getAllContexts().filter(
    (ctx) => ctx.providerId === providerId
  );

  if (usingContexts.length > 0) {
    const profileNames = usingContexts
      .map((ctx) => {
        const profile = profileManager.getProfileById(ctx.profileId);
        return profile ? profile.name : ctx.profileId;
      })
      .join('、');
    return {
      success: false,
      error: '以下窗口正在使用此 Provider，请先在窗口管理中更换这些窗口的平台再删除：' + profileNames,
    };
  }

  const { removeCustomProviderPath } = require('../providers/custom/loader');
  removeCustomProviderPath(filePath);
  return { success: true };
});

// 替换自定义 Provider（弹文件选择框，校验 id 一致后覆盖）
ipcMainForProfile.handle('replace-provider', async (event, { providerId }) => {
  if (!providerId) return { success: false, error: '缺少 providerId' };
  const win = windowState.getMainWindow();
  const result = dialog.showOpenDialogSync(win, {
    properties: ['openFile'],
    filters: [{ name: 'JavaScript', extensions: ['js'] }],
    title: '选择新的 Provider 文件（id 必须为 ' + providerId + '）',
  });
  if (!result || result.length === 0) {
    return { success: false, canceled: true };
  }

  const filePath = result[0];
  const { replaceCustomProvider } = require('../providers/custom/loader');
  try {
    const res = replaceCustomProvider(providerId, filePath);
    return { success: true, provider: { id: res.provider.id, name: res.provider.name, path: res.targetPath } };
  } catch (err) {
    return { success: false, error: '替换失败: ' + err.message };
  }
});

// 用户在平台选择页选择平台后，绑定 profile 并重建窗口（partition 必须随 profile 更新）
ipcMainForProfile.handle('select-platform', async (event, { providerId }) => {
  if (!providerId) return { success: false, error: '缺少平台ID' };
  const ctx = windowState.getContextByWebContents(event.sender);
  if (!ctx) return { success: false, error: '窗口上下文不存在' };

  const provider = getProvider(providerId);
  if (!provider) return { success: false, error: '平台不存在: ' + providerId };

  // 更新该窗口 profile 的 providerId 和 partition
  const updatedProfile = profileManager.updateProfileProvider(ctx.profileId, providerId);
  if (!updatedProfile) return { success: false, error: '更新 profile 失败' };

  // 多标签架构：partition 变化必须重建 webview（partition 属性不可变）→ 通知壳层替换标签
  if (windowState.openProfileAsTab(updatedProfile, { replace: true })) {
    return { success: true, tab: true };
  }

  // 回退（旧多窗口模式）：关闭旧窗口（其 session 仍是旧 partition），用新 profile 重建
  const oldWin = ctx.win;
  if (oldWin && !oldWin.isDestroyed()) {
    oldWin.destroy();
  }
  createWindow(updatedProfile);
  return { success: true };
});

// 打开指定 profile：壳窗口存在 → 在壳内开/聚焦标签；否则回退旧窗口逻辑
ipcMainForProfile.handle('open-profile-window', async (event, { profileId }) => {
  const profile = profileManager.getProfileById(profileId);
  if (!profile) return { success: false, error: '窗口不存在' };
  if (windowState.openProfileAsTab(profile)) {
    return { success: true, focused: true, tab: true };
  }
  // 回退（旧多窗口模式）：已存在则聚焦，不存在则新开窗口
  const existing = windowState.getWindowByProfileId(profileId);
  if (existing && existing.win && !existing.win.isDestroyed()) {
    const win = existing.win;
    if (win.isMinimized()) win.restore();
    win.focus();
    return { success: true, focused: true };
  }
  createWindow(profile, { minimized: true }).catch(e => logger.error('[TokFree] createWindow 失败:', e && e.message));
  try {
    const callerWin = BrowserWindow.fromWebContents(event.sender);
    if (callerWin && !callerWin.isDestroyed()) callerWin.focus();
  } catch (_) {}
  return { success: true, focused: false };
});

// 更新窗口名称（提取到 DeepSeek 用户信息后）
ipcMainForProfile.handle('update-window-name', async (event, { displayName }) => {
  if (!displayName || !displayName.trim()) return { success: false };
  const ctx = windowState.getContextByWebContents(event.sender);
  if (!ctx) return { success: false, error: '窗口上下文不存在' };
  const updated = profileManager.updateProfileName(ctx.profileId, displayName);
  if (updated && ctx.win && !ctx.win.isDestroyed()) {
    ctx.win.setTitle('TokFree - ' + updated.name);
  }
  return { success: !!updated, name: updated ? updated.name : null };
});

// ========== MCP 相关 IPC ==========
const mcpConfig = require('./mcp-config');
const mcpClient = require('./mcp-client');

// 列出所有 MCP server（含启用状态）
ipcMainForProfile.handle('list-mcp-servers', async () => {
  const servers = mcpConfig.getServers();
  const connected = new Set(mcpClient.getConnectedServers().map(s => s.name));
  logger.info('[MCP DEBUG] servers:', JSON.stringify(servers.map(s => ({ name: s.name, enabled: s.enabled }))));
  logger.info('[MCP DEBUG] connected:', JSON.stringify(Array.from(connected)));
  return { success: true, servers: servers.map(s => ({ ...s, connected: connected.has(s.name) })) };
});

// 添加或更新 MCP server 配置
ipcMainForProfile.handle('upsert-mcp-server', async (_event, { server }) => {
  if (!server || !server.name || !server.type) {
    return { success: false, error: 'server 配置不完整（需要 name 和 type）' };
  }
  mcpConfig.upsertServer(server);
  return { success: true };
});

// 删除 MCP server
ipcMainForProfile.handle('remove-mcp-server', async (_event, { name }) => {
  await mcpClient.disconnectServerByName(name);
  mcpConfig.removeServer(name);
  return { success: true };
});

// 启用 MCP server（连接并拉取工具）
ipcMainForProfile.handle('enable-mcp-server', async (_event, { name }) => {
  try {
    mcpConfig.setServerEnabled(name, true);
    await mcpClient.connectServerByName(name);
    logger.info('[MCP DEBUG] enable 完成, connections:', JSON.stringify(Array.from(mcpClient.getConnectedServers().map(s => s.name))));
    return { success: true };
  } catch (err) {
    logger.error('[MCP DEBUG] enable 失败:', err);
    return { success: false, error: err.message };
  }
});

// 禁用 MCP server（断开连接）
ipcMainForProfile.handle('disable-mcp-server', async (_event, { name }) => {
  mcpConfig.setServerEnabled(name, false);
  await mcpClient.disconnectServerByName(name);
  return { success: true };
});

// 获取已启用 server 的工具列表（用于注入提示词）
ipcMainForProfile.handle('get-mcp-tools', async () => {
  return { success: true, tools: mcpClient.getMcpToolList() };
});

// ========== 单实例锁（诊断：临时禁用，测试是否因拿不到锁导致退出） ==========
const gotSingleInstanceLock = true; // app.requestSingleInstanceLock();
logger.info('[TokFree] 单实例锁状态:', gotSingleInstanceLock);
app.on('second-instance', () => {
  const mainWindow = windowState.getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  logger.info('[TokFree] app.whenReady 触发');
  setupAppMenu();
  // 启动清理：清孤儿 partition、旧截图、孤立 session 映射、超大日志（窗口创建前执行）
  try { require('./cleanup').runStartupCleanup(); } catch (e) { logger.warn('[Cleanup] 启动清理异常:', e.message); }
  // 直接进入壳窗口
  createShellWindow().catch(e => logger.error('[TokFree] createShellWindow 失败:', e && e.message));

  // 启动看门狗：检测到 AI 停顿时向对应窗口发送唤醒语
  watchdog.start({
    onWake: (profileId, msg) => {
      const ctx = windowState.getWindowByProfileId(profileId);
      if (ctx && ctx.win && !ctx.win.isDestroyed()) {
        if (ctx.win.isMinimized()) ctx.win.restore();
        ctx.win.webContents.send('watchdog-wake', { msg });
        logger.info('[Watchdog] 已向窗口发送唤醒 profile=' + profileId);
      } else {
        logger.info('[Watchdog] 唤醒失败：窗口未打开 profile=' + profileId);
      }
    },
  });

  // 后台连接已启用的 MCP server，不阻塞窗口创建
  mcpClient.connectEnabledServers().catch(err => {
    logger.error('[MCP] 初始化连接失败:', err.message);
  });

  // 本地 OpenAI 兼容 API 服务：默认关闭；仅当配置 enabled=true 时启动（失败静默，不影响主流程）
  try {
    const apiServer = require('./api-server');
    const cfg = apiServer.readConfig();
    if (cfg && cfg.enabled) {
      const r = apiServer.start(cfg);
      if (r && r.success) logger.info('[ApiServer] 本地 API 服务已启动 http://' + r.host + ':' + r.port);
      else logger.warn('[ApiServer] 启动失败（已忽略）:', r && r.error);
    } else {
      logger.info('[ApiServer] 未启用（默认关闭）');
    }
  } catch (e) {
    logger.error('[ApiServer] 初始化异常（已忽略）:', e && e.message);
  }

  // ShardX 反检测浏览器：首次启动无感就位（失败静默，不阻塞主流程）
  try {
    const shardxManager = require('./shardx-manager');
    shardxManager.ensureShardx().then(function (r) {
      if (r && r.installed && r.mcpReady) {
        // 就位成功：把 shardx server 写进 mcp.json（若尚未配置/非用户手动配置）
        try {
          const mcpConfig = require('./mcp-config');
          const res = mcpConfig.ensureShardxServer(function () { return shardxManager.buildMcpServerConfig(); });
          if (res && res.updated) logger.info('[ShardX] mcp.json 已写入 shardx server');
          else if (res && res.reason) logger.info('[ShardX] mcp.json 未更新：' + res.reason);
        } catch (e2) {
          logger.warn('[ShardX] 写入 mcp.json 失败：' + (e2 && e2.message));
        }
        logger.info('[ShardX] 已就位：installed=' + r.installed + ' mcpReady=' + r.mcpReady);
      } else if (r && r.error) {
        logger.warn('[ShardX] 就位未完成：' + r.error);
      }
    }).catch(function () {});
  } catch (_) {}
});

app.on('window-all-closed', () => {
  // 切换平台时会先销毁旧窗口（select-platform）再创建新窗口，
  // 这个间隙窗口数会短暂为 0，若直接 quit 会导致闪退。
  // 延迟确认：稍后仍无窗口才真正退出。
  // 注意：必须看真实 BrowserWindow 数量，不能看 windowState（后者含 webview 适配器）。
  setTimeout(() => {
    if (BrowserWindow.getAllWindows().length === 0) {
      app.quit();
    }
  }, 500);
});

// 退出前刷新所有 session 数据
let quitFlushed = false;
app.on('before-quit', (event) => {
  if (quitFlushed) return;
  event.preventDefault();
  quitFlushed = true;
  flushAllSessions().finally(() => {
    app.quit();
  });
});

app.on('activate', () => {
  if (windowState.getAllWindows().length === 0) {
    createShellWindow().catch(e => logger.error('[TokFree] createShellWindow 失败:', e && e.message));
  }
});
