/**
 * 暴露给渲染进程的 API（contextBridge + window 兜底）
 * 由原 preload.js 拆分而来，行为保持不变。
 */
const { contextBridge, ipcRenderer } = require('electron');

// ========== 暴露给渲染进程的 API ==========
// 尝试 contextBridge，如果失败则直接挂载到 window（作为 fallback）
let electronAPI = {
  executeCommand: (command, id) => {
    return ipcRenderer.invoke('execute-command', { command, id });
  },
  initProject: (projectDir, isCompaction) => {
    return ipcRenderer.invoke('init-project', {
      skipPrompt: false,
      projectDir: projectDir || null,
      isCompaction: !!isCompaction,
    });
  },
  updateProjectDir: () => {
    return ipcRenderer.invoke('init-project', { skipPrompt: true });
  },
  executeTool: (toolName, params, callId) => {
    return ipcRenderer.invoke('execute-tool', { toolName, params, callId });
  },
  executeJs: (code, callId) => {
    return ipcRenderer.invoke('execute-js', { code, callId });
  },
  sendEnterToChat: () => {
    return ipcRenderer.invoke('chat-send-enter');
  },
  listSessions: () => {
    return ipcRenderer.invoke('list-sessions');
  },
  // 保存全量会话目录（从网页端抓取后回传主进程持久化）
  saveSessionCatalog: (conversations) => {
    return ipcRenderer.invoke('save-session-catalog', { conversations });
  },
  // 抓取全量会话目录并保存到主进程（在 preload 世界执行：可用 require + fetch）
  fetchSessionCatalog: () => {
    try {
      const m = require('./dom/session-catalog');
      if (!m || typeof m.fetchAllConversations !== 'function') {
        return Promise.resolve({ ok: false, error: 'session-catalog 不可用' });
      }
      return Promise.resolve(m.fetchAllConversations()).then((r) => {
        if (r && r.ok && r.conversations && r.conversations.length) {
          return ipcRenderer.invoke('save-session-catalog', { conversations: r.conversations }).then(() => r);
        }
        return r;
      });
    } catch (err) {
      return Promise.resolve({ ok: false, error: (err && err.message) || String(err) });
    }
  },
  navigateSession: (sessionId) => {
    return ipcRenderer.invoke('navigate-session', { sessionId });
  },
  // 重命名会话（本地别名）
  renameSession: (sessionId, alias) => {
    return ipcRenderer.invoke('rename-session', { sessionId, alias });
  },
  // 重命名网页端会话（同步到平台会话标题，失败不影响本地别名）
  renameRemoteSession: (sessionId, newTitle) => {
    try {
      const ci = require('./dom/chat-input');
      if (ci && typeof ci.renameRemoteSession === 'function') {
        return Promise.resolve(ci.renameRemoteSession(sessionId, newTitle));
      }
      return Promise.resolve({ success: false, error: 'not available' });
    } catch (err) {
      return Promise.resolve({ success: false, error: (err && err.message) || String(err) });
    }
  },
  // 主动拉取当前项目目录（启动时兜底，避免错过 project-dir-updated 推送）
  getProjectDir: () => {
    return ipcRenderer.invoke('get-project-dir');
  },
  // 提取当前会话的结构化内容（壳层 Agent 视图渲染用；本函数在页面上下文读 DOM）
  extractConversation: () => {
    try {
      const extractor = require('./dom/conversation-extract');
      return Promise.resolve(extractor.extractConversation());
    } catch (err) {
      return Promise.resolve({ ok: false, error: (err && err.message) || String(err) });
    }
  },
  createProfileWindow: () => {
    return ipcRenderer.invoke('create-profile-window');
  },
  listProfiles: () => {
    return ipcRenderer.invoke('list-profiles');
  },
  openProfileWindow: (profileId) => {
    return ipcRenderer.invoke('open-profile-window', { profileId });
  },
  deleteProfileWindow: (profileId) => {
    return ipcRenderer.invoke('delete-profile', { profileId });
  },
  updateWindowName: (displayName) => {
    return ipcRenderer.invoke('update-window-name', { displayName });
  },
  // 会话收发计数上报
  recordConversation: (type) => {
    return ipcRenderer.invoke('record-conversation', { type });
  },
  // 子 Agent token 用量上报（供主大脑感知 token 消耗）
  reportTokenUsage: (count) => {
    return ipcRenderer.invoke('report-token-usage', { count });
  },
  // Token 增量上报（供按天累计统计）
  reportTokenDelta: (delta) => {
    return ipcRenderer.invoke('report-token-delta', { delta });
  },
  // 用量汇总（今日/本周/各窗口明细/每日序列）
  getStatsSummary: (days) => {
    return ipcRenderer.invoke('stats-summary', { days });
  },
  // Token 用量汇总（今日/本周/总计/每日序列）
  getTokenStats: (days) => {
    return ipcRenderer.invoke('stats-token', { days });
  },
  // ===== 数据看板（metrics-store 指标）=====
  metricsDaily: (profileId, date) => ipcRenderer.invoke('metrics-daily', { profileId: profileId || '', date: date || null }),
  metricsRange: (profileId, from, to) => ipcRenderer.invoke('metrics-range', { profileId: profileId || '', from, to }),
  metricsSummary: (profileId) => ipcRenderer.invoke('metrics-summary', { profileId: profileId || '' }),
  // ========== 看门狗 API ==========
  reportPageState: (state) => ipcRenderer.invoke('report-page-state', { state }),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', { theme }),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  // 回执发送延迟（全局，跨标签共享）
  getSendDelay: () => ipcRenderer.invoke('get-send-delay'),
  setSendDelay: (min, max) => ipcRenderer.invoke('set-send-delay', { min, max }),
  // 订阅主题变更（主进程 set-theme 后广播），回调收到 'dark'|'light'，返回取消订阅函数
  onThemeChanged: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_e, p) => { try { cb(p && p.theme); } catch (_) {} };
    ipcRenderer.on('theme-changed', listener);
    return () => { try { ipcRenderer.removeListener('theme-changed', listener); } catch (_) {} };
  },
  watchdogSetEnabled: (enabled) => ipcRenderer.invoke('watchdog-set-enabled', { enabled }),
  watchdogGetConfig: () => ipcRenderer.invoke('watchdog-get-config'),
  watchdogArm: (reset) => {
    return ipcRenderer.invoke('watchdog-arm', { reset });
  },
  watchdogTouch: () => {
    return ipcRenderer.invoke('watchdog-touch');
  },
  watchdogReplied: () => {
    return ipcRenderer.invoke('watchdog-replied');
  },
  watchdogInterrupted: () => {
    return ipcRenderer.invoke('watchdog-interrupted');
  },
  watchdogButtonIdle: () => {
    return ipcRenderer.invoke('watchdog-button-idle');
  },
  watchdogScheduleConfirm: (text) => {
    return ipcRenderer.invoke('watchdog-schedule-confirm', { text });
  },
  watchdogBusy: (note, secs) => {
    return ipcRenderer.invoke('watchdog-busy', { note, secs });
  },
  watchdogClearBusy: () => {
    return ipcRenderer.invoke('watchdog-clear-busy');
  },
  watchdogStatus: () => {
    return ipcRenderer.invoke('watchdog-status');
  },
  watchdogWake: () => {
    return ipcRenderer.invoke('watchdog-wake-now');
  },
  noteRateLimit: (hitWord) => {
    return ipcRenderer.invoke('watchdog-note-ratelimit', { hitWord });
  },
  watchdogSetPaused: (paused) => {
    return ipcRenderer.invoke('watchdog-set-paused', { paused });
  },
  showAiNotification: () => {
    return ipcRenderer.invoke('show-ai-notification');
  },
  // 多 Agent 模式开关
  getTeamMode: () => {
    return ipcRenderer.invoke('get-team-mode');
  },
  // 引导者（Curator）驱动器
  curatorGetConfig: () => ipcRenderer.invoke('curator-get-config'),
  curatorSetConfig: (patch) => ipcRenderer.invoke('curator-set-config', patch || {}),
  curatorTriggerNow: () => ipcRenderer.invoke('curator-trigger-now'),
  // 定时任务（用户可管理的轻量定时注入）
  scheduledTaskList: () => ipcRenderer.invoke('scheduled-task-list'),
  scheduledTaskCreate: (opts) => ipcRenderer.invoke('scheduled-task-create', opts || {}),
  scheduledTaskRemove: (id) => ipcRenderer.invoke('scheduled-task-remove', { id: id }),
  scheduledTaskToggle: (id, enabled) => ipcRenderer.invoke('scheduled-task-toggle', { id: id, enabled: !!enabled }),
  // 自进化飞轮总开关（含引导者/自驱循环/自动进化）
  evolutionGetConfig: () => ipcRenderer.invoke('evolution-get-config'),
  evolutionSetConfig: (patch) => ipcRenderer.invoke('evolution-set-config', patch || {}),
  // 汇总所有窗口 AI 状态（窗口管理面板用）
  watchdogNoteBanned: (info) => ipcRenderer.invoke('watchdog-note-banned', info || {}),
  watchdogClearBanned: () => ipcRenderer.invoke('watchdog-clear-banned'),
  listWindowsStatus: () => {
    return ipcRenderer.invoke('list-windows-status');
  },
  // ========== 事件日志 API（窗口管理面板：运行统计/日志） ==========
  getEventLog: (limit) => {
    return ipcRenderer.invoke('event-log-recent', { limit });
  },
  getEventStats: () => {
    return ipcRenderer.invoke('event-log-stats');
  },
  // 任务清单（todo_write）读取：覆盖层「任务清单」面板
  getTodos: () => {
    return ipcRenderer.invoke('todo-list');
  },
  // 自驱循环目标进度读取：覆盖层「目标进度」面板
  goalStatusList: (projectDir) => {
    return ipcRenderer.invoke('goal-status-list', { projectDir });
  },
  // 账号池 / 代理 / 指纹（窗口管理升级）
  getProfileConfig: (profileId) => ipcRenderer.invoke('get-profile-config', { profileId }),
  setProfileAccount: (profileId, account) => ipcRenderer.invoke('set-profile-account', { profileId, account }),
  setProfileProxy: (profileId, proxy) => ipcRenderer.invoke('set-profile-proxy', { profileId, proxy }),
  testProfileProxy: (profileId, proxy) => ipcRenderer.invoke('test-profile-proxy', { profileId, proxy }),
  setProfileFingerprint: (profileId, fingerprint) => ipcRenderer.invoke('set-profile-fingerprint', { profileId, fingerprint }),
  setTeamMode: (mode) => {
    return ipcRenderer.invoke('set-team-mode', { mode });
  },
  // 手动设置窗口角色：master / worker / ''（清除）
  setProfileRole: (profileId, role, belongTo) => {
    return ipcRenderer.invoke('set-profile-role', { profileId, role, belongTo });
  },
  // ========== 工作模式（Plan/Act）+ 操作确认 ==========
  getPolicy: () => {
    return ipcRenderer.invoke('policy-get');
  },
  setPolicyMode: (mode) => {
    return ipcRenderer.invoke('policy-set-mode', { mode });
  },
  setPolicyTrust: (confirmDangerous) => {
    return ipcRenderer.invoke('policy-set-trust', { confirmDangerous });
  },
  // 全局默认（设置面板用）：影响所有未单独覆盖的标签
  setPolicyGlobalTrust: (confirmDangerous) => {
    return ipcRenderer.invoke('policy-set-global-trust', { confirmDangerous });
  },
  setPolicyGlobalMode: (mode) => {
    return ipcRenderer.invoke('policy-set-global-mode', { mode });
  },
  getPolicyGlobal: () => {
    return ipcRenderer.invoke('policy-get-global');
  },
  onToolConfirm: (cb) => {
    ipcRenderer.on('tool-confirm-request', (_event, payload) => {
      try { cb(payload); } catch (e) { console.error('[TokFree] onToolConfirm 回调异常:', e); }
    });
  },
  respondToolConfirm: (requestId, ok) => {
    return ipcRenderer.invoke('tool-confirm-response', { requestId, ok });
  },
  // AI 协作：向主进程确认本 Worker 已真实收到派发任务（双向确认 ack）
  ackWorkerTask: (taskId) => ipcRenderer.invoke('worker-task-ack', { taskId }),
  triggerRelogin: (profileId) => ipcRenderer.invoke('trigger-relogin', { profileId }),
  reportAiResponse: (text, taskId) => {
    return ipcRenderer.invoke('report-ai-response', {
      text: typeof text === 'string' ? text : '',
      taskId: taskId || '',
    });
  },
  // ========== MCP 相关 API ==========
  listMcpServers: () => {
    return ipcRenderer.invoke('list-mcp-servers');
  },
  upsertMcpServer: (server) => {
    return ipcRenderer.invoke('upsert-mcp-server', { server });
  },
  removeMcpServer: (name) => {
    return ipcRenderer.invoke('remove-mcp-server', { name });
  },
  enableMcpServer: (name) => {
    return ipcRenderer.invoke('enable-mcp-server', { name });
  },
  disableMcpServer: (name) => {
    return ipcRenderer.invoke('disable-mcp-server', { name });
  },
  getMcpTools: () => {
    return ipcRenderer.invoke('get-mcp-tools');
  },
  // ========== 知识库 / 技能库 API ==========
  knowledgeList: () => ipcRenderer.invoke('knowledge-list'),
  knowledgeRead: (name) => ipcRenderer.invoke('knowledge-read', { name }),
  knowledgeSave: (name, content, meta) => ipcRenderer.invoke('knowledge-save', { name, content, meta }),
  knowledgeCreate: (name, content, meta) => ipcRenderer.invoke('knowledge-create', { name, content, meta }),
  knowledgeDelete: (name) => ipcRenderer.invoke('knowledge-delete', { name }),
  knowledgeEnable: (name) => ipcRenderer.invoke('knowledge-enable', { name }),
  knowledgeDisable: (name) => ipcRenderer.invoke('knowledge-disable', { name }),
  knowledgeGetEnabled: () => ipcRenderer.invoke('knowledge-get-enabled'),
  knowledgeVersionList: (name) => ipcRenderer.invoke('knowledge-version-list', { name }),
  knowledgeVersionRestore: (name, version) => ipcRenderer.invoke('knowledge-version-restore', { name, version }),
  preferenceRead: () => ipcRenderer.invoke('preference-read'),
  preferenceSave: (content) => ipcRenderer.invoke('preference-save', { content }),
  // ========== 账号池 / 窗口绑定账号 / 失败选号 ==========
  listAccounts: (providerId) => ipcRenderer.invoke('account-pool-list', { providerId }),
  // 一键登录：用选中的账号在当前窗口登录（主进程用 event.sender 反查窗口 profileId）
  quickLogin: (accountId, profileId) => ipcRenderer.invoke('account-quick-login', { accountId, profileId }),
  // 获取当前窗口自身的 profileId（账号选择框用于区分自己占用/他人占用）
  getCurrentProfileId: () => ipcRenderer.invoke('get-current-profile-id'),
  createAccount: (account) => ipcRenderer.invoke('account-pool-create', { account }),
  updateAccount: (id, patch) => ipcRenderer.invoke('account-pool-update', { id, patch }),
  deleteAccount: (id) => ipcRenderer.invoke('account-pool-delete', { id }),
  bindAccount: (profileId, accountId) => ipcRenderer.invoke('profile-bind-account', { profileId, accountId }),
  onReloginFailed: (cb) => {
    ipcRenderer.on('account-relogin-failed', (_event, payload) => {
      try { cb(payload); } catch (e) { console.error('[TokFree] onReloginFailed 回调异常:', e); }
    });
  },
  // 需要用户从账号池选择账号（进入登录页且未绑定/登录失败时）
  onNeedAccountSelect: (cb) => {
    ipcRenderer.on('account-need-select', (_event, payload) => {
      try { cb(payload); } catch (e) { console.error('[TokFree] onNeedAccountSelect 回调异常:', e); }
    });
  },
  // 查询账号占用：{ [accountId]: [{profileId, profileName}] }
  listAccountUsage: () => ipcRenderer.invoke('account-usage-list'),
  // 读取本地文件为 base64（供把文件作为附件上传到网页版 AI）
  readFileBase64: (path) => ipcRenderer.invoke('read-file-base64', { path }),
  // 把本地文件作为附件上传到当前网页版 AI 聊天（壳层经 execInActive 调用）
  attachLocalFile: (path) => {
    try {
      const ci = require('./dom/chat-input');
      return Promise.resolve(ci.attachFileToChat(path));
    } catch (err) {
      return Promise.resolve({ success: false, error: (err && err.message) || String(err) });
    }
  },
  // 需求1b：读取网页输入区当前已挂载的「待发送附件」（文件名/缩略图列表）。
  // 供壳端 Agent 视图实时显示"网页端上传了什么附件"（网页端上传 / 壳端📎 / 拖拽 三种来源统一）。
  readPendingAttachments: () => {
    try {
      const ci = require('./dom/chat-input');
      return ci.readPendingAttachments() || [];
    } catch (err) {
      return [];
    }
  },
  // 需求1b：异步版——把图片附件的 blob 缩略图在 webview 内转成 dataURL 后返回，
  // 供壳层（不同上下文）显示真实缩略图（blob URL 跨上下文会破图）。
  readPendingAttachmentsAsync: () => {
    try {
      const ci = require('./dom/chat-input');
      if (ci && typeof ci.readPendingAttachmentsAsync === 'function') {
        return ci.readPendingAttachmentsAsync();
      }
      return Promise.resolve(ci.readPendingAttachments() || []);
    } catch (err) {
      return Promise.resolve([]);
    }
  },
  // 需求1c：按文件名移除网页输入区的一个「待发附件」（供壳层 chip 的「×」调用）。
  // 返回 { success, error? }；壳层经 execInActive 调用。
  removePendingAttachment: (name) => {
    try {
      const ci = require('./dom/chat-input');
      if (ci && typeof ci.removePendingAttachment === 'function') {
        return ci.removePendingAttachment(name);
      }
      return Promise.resolve({ success: false, error: 'removePendingAttachment 不可用' });
    } catch (err) {
      return Promise.resolve({ success: false, error: (err && err.message) || String(err) });
    }
  },
  // 深度思考开关：读取网页端当前状态（壳端按钮同步显示用）
  readDeepThink: () => {
    try {
      const ci = require('./dom/chat-input');
      if (ci && typeof ci.readDeepThinkState === 'function') {
        return ci.readDeepThinkState();
      }
      return { available: false, on: false };
    } catch (err) {
      return { available: false, on: false };
    }
  },
  // 深度思考开关：切换网页端状态，返回 { ok, changed, available }
  setDeepThink: (on) => {
    try {
      const ci = require('./dom/chat-input');
      if (ci && typeof ci.setDeepThink === 'function') {
        return ci.setDeepThink(on);
      }
      return { ok: false, changed: false, available: false };
    } catch (err) {
      return { ok: false, changed: false, available: false, error: (err && err.message) || String(err) };
    }
  },
  // 软件更新：手动检查（触发 updater.checkForUpdates）
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  // 磁盘清理
  cleanupUsage: () => ipcRenderer.invoke('cleanup-usage'),
  cleanupCache: () => ipcRenderer.invoke('cleanup-cache'),
  cleanupAll: () => ipcRenderer.invoke('cleanup-all'),
  respondReloginSelect: (profileId, accountId) => {
    return ipcRenderer.invoke('account-relogin-select', { profileId, accountId });
  },
  // ========== 平台相关 API ==========
  listProviders: () => {
    return ipcRenderer.invoke('list-providers');
  },
  selectPlatform: (providerId) => {
    return ipcRenderer.invoke('select-platform', { providerId });
  },
  createProfileWindowWithProvider: (providerId) => {
    return ipcRenderer.invoke('create-profile-window', { providerId });
  },
  importProvider: () => {
    return ipcRenderer.invoke('import-provider');
  },
  removeProvider: (filePath, providerId) => {
    return ipcRenderer.invoke('remove-provider', { path: filePath, providerId });
  },
  replaceProvider: (providerId) => {
    return ipcRenderer.invoke('replace-provider', { providerId });
  },
  // ========== Git 集成 ==========
  gitStatus: (projectDir) => ipcRenderer.invoke('git-status', { projectDir }),
  gitDiff: (file, projectDir) => ipcRenderer.invoke('git-diff', { file, projectDir }),
  // API 型 Provider 传输通道（新增）：经主进程向 OpenAI 兼容后端发请求，规避 CORS。
  // opts = { baseUrl, path, authKey, method?, body?, stream? }
  apiProviderRequest: (opts) => ipcRenderer.invoke('api-provider-request', opts),
  // 本地 OpenAI 兼容 API：把网页 AI 的回复回传主进程（供挂起的 HTTP 请求 resolve）
  reportApiResponse: (requestId, text) => ipcRenderer.invoke('api-response', { requestId, text }),
  // 本地 OpenAI 兼容 API 服务开关/端口（读/写配置 + 起停）
  apiServerGet: () => ipcRenderer.invoke('api-server-get'),
  apiServerSet: (patch) => ipcRenderer.invoke('api-server-set', patch),
  // ShardX 反检测浏览器：只读状态查询
  shardxStatus: () => ipcRenderer.invoke('shardx-status'),
};

try {
  contextBridge.exposeInMainWorld('electronAPI', electronAPI);
} catch (err) {
  console.error('[TokFree] contextBridge.exposeInMainWorld 失败:', err);
}

// 反检测加固（主世界）：contextBridge 在主世界创建的 electronAPI 默认可枚举，
// 页面可用 Object.keys(window) 扫到并识别为「非官方客户端」。
// 在页面脚本执行前，于主世界把它重定义为不可枚举（直接访问仍照常可用）。
try {
  const { webFrame } = require('electron');
  webFrame.executeJavaScript(
    "try{if(window.electronAPI){var a=window.electronAPI;Object.defineProperty(window,'electronAPI',{value:a,writable:true,configurable:true,enumerable:false});}}catch(e){}"
  );
} catch (_) {}

// 无论 contextBridge 是否成功，都直接挂载到 window 作为备选。
// 反检测加固：改为「不可枚举」属性——内部代码 window.electronAPI.xxx 照常可用，
// 但页面的 Object.keys(window)/for...in/JSON 序列化都扫不到它，避免被识别为非官方客户端。
try {
  Object.defineProperty(window, 'electronAPI', {
    value: electronAPI,
    writable: true,
    configurable: true,
    enumerable: false,
  });
} catch (_) {
  window.electronAPI = electronAPI;
}
