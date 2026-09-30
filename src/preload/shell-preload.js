/**
 * 壳窗口 Preload（TokFree 多标签壳）
 * 通过 additionalArguments 把 webview 的 preload 绝对路径传给渲染层，
 * 供 <webview> 的 preload 属性使用（让现有覆盖层/拦截/工具逻辑在标签内生效）。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

let webviewPreload = '';
try {
  for (const a of process.argv) {
    if (typeof a === 'string' && a.startsWith('--tokfree-webview-preload=')) {
      webviewPreload = decodeURIComponent(a.slice('--tokfree-webview-preload='.length));
    }
  }
} catch (_) {}

contextBridge.exposeInMainWorld('shellAPI', {
  webviewPreload,
  // 拖拽上传：Electron 33+ 已移除 File.path，改用 webUtils.getPathForFile 取绝对路径。
  // 这是 Electron 官方推荐做法（在 preload 隔离世界内调用，File 由 contextBridge 传递）。
  // 任何异常/不可用都返回空串，由壳层回退提示"请点📎选择"。
  getPathForFile: (file) => {
    try { return (webUtils && webUtils.getPathForFile) ? (webUtils.getPathForFile(file) || '') : ''; } catch (_) { return ''; }
  },
  // 修复 3 配套：为每个新标签向主进程申请一个 profile（partition = persist:<profileId>），
  // 主进程在 did-attach-webview 时据该 partition 反查 profile，把 webview 的 webContents
  // 注册进 windowState，使覆盖层/工具/看门狗等 IPC 能找到归属。
  createTabProfile: (name) => ipcRenderer.invoke('create-tab-profile', { name }),
  // 主进程 → 壳层命令（打开/替换标签）。shell.js 通过此回调收到 'shell-open-tab' 事件。
  onShellCommand: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, payload) => { try { cb(payload); } catch (_) {} };
    ipcRenderer.on('shell-open-tab', listener);
    return () => { try { ipcRenderer.removeListener('shell-open-tab', listener); } catch (_) {} };
  },
  // 主进程 → 壳层命令（关闭标签）。删除窗口时联动关闭对应标签页。
  onShellCloseTab: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, payload) => { try { cb(payload); } catch (_) {} };
    ipcRenderer.on('shell-close-tab', listener);
    return () => { try { ipcRenderer.removeListener('shell-close-tab', listener); } catch (_) {} };
  },
  // 壳窗口快捷键（Ctrl+T 新标签 / Ctrl+W 关标签，菜单栏移除后由壳窗口级拦截）
  onShellShortcut: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, action) => { try { cb(action); } catch (_) {} };
    ipcRenderer.on('shell-shortcut', listener);
    return () => { try { ipcRenderer.removeListener('shell-shortcut', listener); } catch (_) {} };
  },
  // ===== 全局窗口管理（壳层级）=====
  // list-profiles / list-windows-status / list-providers / open-profile-window /
  // create-profile-window 均为主进程全局 ipcMain handler（不区分 sender），壳窗口可直接调用。
  listProfiles: () => ipcRenderer.invoke('list-profiles'),
  listWindowsStatus: () => ipcRenderer.invoke('list-windows-status'),
  listProviders: () => ipcRenderer.invoke('list-providers'),
  // 打开/聚焦某 profile：主进程 → 壳层 'shell-open-tab' → shell.js handleShellCommand 建/切标签
  openProfileWindow: (profileId) => ipcRenderer.invoke('open-profile-window', { profileId }),
  createProfileWindow: () => ipcRenderer.invoke('create-profile-window'),
  createProfileWindowWithProvider: (providerId) => ipcRenderer.invoke('create-profile-window', { providerId }),
  // 上传附件：弹文件选择框，返回 { success, paths }
  selectFile: () => ipcRenderer.invoke('shell:select-file'),
  // 粘贴上传：把剪贴板 File 的 base64 内容落盘到系统临时目录，返回 { success, path }
  saveTempFile: (base64, name) => ipcRenderer.invoke('shell:save-temp-file', { base64, name }),
  // 保存 AI 消息图片到本地：dataURL 直接传（主进程解码写盘）；http(s) URL 传 url 由主进程下载后写。
  saveImage: (payload) => ipcRenderer.invoke('shell:save-image', payload || {}),
  // 壳窗口信息（isPackaged 等）：打包后壳层据此隐藏临时调试开关
  getShellInfo: () => ipcRenderer.invoke('shell:get-info'),
  // 主题：统一真源在主进程（settings.theme），壳层通过 IPC 读写 + 订阅广播
  getTheme: () => ipcRenderer.invoke('get-theme'),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', { theme }),
  onThemeChanged: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_e, p) => { try { cb(p && p.theme); } catch (_) {} };
    ipcRenderer.on('theme-changed', listener);
    return () => { try { ipcRenderer.removeListener('theme-changed', listener); } catch (_) {} };
  },
  // 跨窗口同步：任何窗口重命名会话后，主进程广播；壳层据此刷新会话列表显示新别名
  onSessionRenamed: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_e, p) => { try { cb(p || {}); } catch (_) {} };
    ipcRenderer.on('session-renamed', listener);
    return () => { try { ipcRenderer.removeListener('session-renamed', listener); } catch (_) {} };
  },
  // ===== MCP 管理（壳层级全局面板，跨标签常驻）=====
  mcpListServers: () => ipcRenderer.invoke('list-mcp-servers'),
  mcpUpsertServer: (server) => ipcRenderer.invoke('upsert-mcp-server', { server }),
  mcpRemoveServer: (name) => ipcRenderer.invoke('remove-mcp-server', { name }),
  mcpEnableServer: (name) => ipcRenderer.invoke('enable-mcp-server', { name }),
  mcpDisableServer: (name) => ipcRenderer.invoke('disable-mcp-server', { name }),
  mcpGetTools: () => ipcRenderer.invoke('get-mcp-tools'),
  // ===== 账号池（壳层级全局面板，跨标签常驻）=====
  accountList: (providerId) => ipcRenderer.invoke('account-pool-list', { providerId }),
  accountCreate: (account) => ipcRenderer.invoke('account-pool-create', { account }),
  accountUpdate: (id, patch) => ipcRenderer.invoke('account-pool-update', { id, patch }),
  accountDelete: (id) => ipcRenderer.invoke('account-pool-delete', { id }),
  accountUsageList: () => ipcRenderer.invoke('account-usage-list'),
  // ===== 窗口管理增强（壳层级全局面板）=====
  // 看门狗：status/wake 走壳层专用 handler（显式 profileId，不依赖 sender ctx）；
  // set-paused/get-config 是全局配置，复用原 handler。
  swmWatchdogStatus: (profileId) => ipcRenderer.invoke('shell:watchdog-status', { profileId }),
  swmWatchdogWake: (profileId) => ipcRenderer.invoke('shell:watchdog-wake-now', { profileId }),
  swmWatchdogSetPaused: (paused) => ipcRenderer.invoke('watchdog-set-paused', { paused }),
  swmWatchdogGetConfig: () => ipcRenderer.invoke('watchdog-get-config'),
  // 运行统计：全局 handler
  swmGetEventStats: () => ipcRenderer.invoke('event-log-stats'),
  // Token / 成本用量汇总（今日 / 本周 / 各窗口明细 / 每日序列）
  getStatsSummary: (days) => ipcRenderer.invoke('stats-summary', { days }),
  // Token 用量汇总（今日 / 本周 / 总计 / 每日序列，供柱状图）
  getTokenStats: (days) => ipcRenderer.invoke('stats-token', { days }),
  // ZCode 风格使用统计（KPI + 热力图 + 趋势 + 按窗口饼图）
  shellUsageStats: (opts) => ipcRenderer.invoke('shell:usage-stats', opts || {}),
  // ===== 数据看板（metrics-store）=====
  // profileId 显式传入（壳窗口非 webview）；空串 = 汇总所有窗口。
  metricsDaily: (profileId, date) => ipcRenderer.invoke('metrics-daily', { profileId: profileId || '', date: date || null }),
  metricsRange: (profileId, from, to) => ipcRenderer.invoke('metrics-range', { profileId: profileId || '', from, to }),
  metricsSummary: (profileId) => ipcRenderer.invoke('metrics-summary', { profileId: profileId || '' }),
  swmGetEventLog: (limit) => ipcRenderer.invoke('event-log-recent', { limit }),
  // 窗口设置：显式 profileId 的全局 handler
  swmGetProfileConfig: (profileId) => ipcRenderer.invoke('get-profile-config', { profileId }),
  swmSetProfileAccount: (profileId, account) => ipcRenderer.invoke('set-profile-account', { profileId, account }),
  swmSetProfileProxy: (profileId, proxy) => ipcRenderer.invoke('set-profile-proxy', { profileId, proxy }),
  swmTestProfileProxy: (profileId, proxy) => ipcRenderer.invoke('test-profile-proxy', { profileId, proxy }),
  swmSetProfileFingerprint: (profileId, fingerprint) => ipcRenderer.invoke('set-profile-fingerprint', { profileId, fingerprint }),
  // 窗口操作：全局 handler
  swmDeleteProfileWindow: (profileId) => ipcRenderer.invoke('delete-profile', { profileId }),
  swmSetProfileRole: (profileId, role, belongTo) => ipcRenderer.invoke('set-profile-role', { profileId, role, belongTo }),
  swmListAccounts: (providerId) => ipcRenderer.invoke('account-pool-list', { providerId }),
  swmBindAccount: (profileId, accountId) => ipcRenderer.invoke('profile-bind-account', { profileId, accountId }),
  swmTriggerRelogin: (profileId) => ipcRenderer.invoke('trigger-relogin', { profileId }),
  // ===== 知识库 / 技能库（壳层级全局面板，跨标签常驻）=====
  // projectDir：当前活动标签的项目目录（壳层从右栏读取后显式传入；不传则由主进程按 sender 推导）。
  knowledgeList: (projectDir) => ipcRenderer.invoke('knowledge-list', { projectDir }),
  knowledgeRead: (name) => ipcRenderer.invoke('knowledge-read', { name }),
  knowledgeSave: (name, content, meta) => ipcRenderer.invoke('knowledge-save', { name, content, meta }),
  knowledgeCreate: (name, content, meta) => ipcRenderer.invoke('knowledge-create', { name, content, meta }),
  knowledgeDelete: (name) => ipcRenderer.invoke('knowledge-delete', { name }),
  knowledgeEnable: (name, projectDir) => ipcRenderer.invoke('knowledge-enable', { name, projectDir }),
  knowledgeDisable: (name, projectDir) => ipcRenderer.invoke('knowledge-disable', { name, projectDir }),
  knowledgeEnableGlobal: (name) => ipcRenderer.invoke('knowledge-enable-global', { name }),
  knowledgeDisableGlobal: (name) => ipcRenderer.invoke('knowledge-disable-global', { name }),
  knowledgeGetEnabled: (projectDir) => ipcRenderer.invoke('knowledge-get-enabled', { projectDir }),
  knowledgeVersionList: (name) => ipcRenderer.invoke('knowledge-version-list', { name }),
  knowledgeVersionRestore: (name, version) => ipcRenderer.invoke('knowledge-version-restore', { name, version }),
  preferenceRead: () => ipcRenderer.invoke('preference-read'),
  preferenceSave: (content) => ipcRenderer.invoke('preference-save', { content }),
  // ===== 工具策略（Plan/Act + 信任模式）—— 每标签独立控件，壳窗口 sender 非 webview，显式传 profileId =====
  // 标签后台节流：切标签时对非活动标签的 webview 启用节流（省 CPU/内存），活动标签关闭节流
  setTabThrottled: (profileId, throttled) => ipcRenderer.invoke('shell:set-tab-throttled', { profileId, throttled: !!throttled }),
  policyGet: (profileId) => ipcRenderer.invoke('shell:policy-get', { profileId }),
  policySetTrust: (profileId, confirmDangerous) => ipcRenderer.invoke('shell:policy-set-trust', { profileId, confirmDangerous }),
  policySetMode: (profileId, mode) => ipcRenderer.invoke('shell:policy-set-mode', { profileId, mode }),
  policyGetGlobal: () => ipcRenderer.invoke('shell:policy-get-global'),
  // @ 引用文件：扫描当前项目文件列表（供输入框 @ 补全）。projectDir 显式传入（壳窗口非 webview）。
  listProjectFiles: (projectDir) => ipcRenderer.invoke('list-project-files', { projectDir }),
  // 任务清单（壳层级读取）：壳窗口 sender 非 webview，需显式传 profileId。
  shellTodoList: (profileId) => ipcRenderer.invoke('shell:todo-list', { profileId: profileId || '' }),
  // 编排计划（plan，多 Agent 模式）：壳层读取主大脑的计划进度（进程胶囊优先数据源）。
  shellPlanGet: (profileId) => ipcRenderer.invoke('shell:plan-get', { profileId: profileId || '' }),
  // 任务计时上报（方案B）：胶囊任务结束（onActiveChange true→false）时把本轮时长上报主进程
  reportTaskDuration: (durationMs, profileId) => ipcRenderer.invoke('report-task-duration', { durationMs, profileId: profileId || '' }),
  // ===== 会话搜索 / 导出（壳层入口）=====
  // 搜索：按 sessionId / 别名 / 项目目录模糊匹配（主进程 session-store.searchSessions）。
  sessionSearch: (query, projectDir, profileId) => ipcRenderer.invoke('session-search', { query, projectDir: projectDir || null, profileId: profileId || null }),
  // 导出：消息由壳层从 webview 采集后传入，主进程序列化并写入下载目录。
  sessionExport: (sessionId, messages, format, outPath) => ipcRenderer.invoke('session-export', { sessionId, messages, format, outPath }),
  // ===== 全局设置弹窗（壳层级）：主进程类设置 + 广播 localStorage 类设置到各 webview =====
  // 看门狗（生命监护）总开关：全局 handler，不依赖 sender
  shellWatchdogGetConfig: () => ipcRenderer.invoke('watchdog-get-config'),
  shellWatchdogSetEnabled: (enabled) => ipcRenderer.invoke('watchdog-set-enabled', { enabled }),
  // 引导者（Curator）：全局配置
  shellCuratorGetConfig: () => ipcRenderer.invoke('curator-get-config'),
  shellCuratorSetConfig: (patch) => ipcRenderer.invoke('curator-set-config', patch || {}),
  shellCuratorTriggerNow: () => ipcRenderer.invoke('curator-trigger-now'),
  // 定时任务（用户可管理的轻量定时注入）
  shellScheduledTaskList: () => ipcRenderer.invoke('scheduled-task-list'),
  shellScheduledTaskCreate: (opts) => ipcRenderer.invoke('scheduled-task-create', opts || {}),
  shellScheduledTaskRemove: (id) => ipcRenderer.invoke('scheduled-task-remove', { id: id }),
  shellScheduledTaskToggle: (id, enabled) => ipcRenderer.invoke('scheduled-task-toggle', { id: id, enabled: !!enabled }),
  // 自进化飞轮总开关：全局配置
  shellEvolutionGetConfig: () => ipcRenderer.invoke('evolution-get-config'),
  shellEvolutionSetConfig: (patch) => ipcRenderer.invoke('evolution-set-config', patch || {}),
  // 本地 OpenAI 兼容 API：全局配置 + 起停（壳层级设置弹窗读写）
  apiServerGet: () => ipcRenderer.invoke('api-server-get'),
  apiServerSet: (patch) => ipcRenderer.invoke('api-server-set', patch || {}),
  // 工具模式（Plan/Act）+ 信任模式：全局默认
  shellPolicyGetGlobal: () => ipcRenderer.invoke('shell:policy-get-global'),
  shellPolicySetGlobalMode: (mode) => ipcRenderer.invoke('policy-set-global-mode', { mode }),
  shellPolicySetGlobalTrust: (confirmDangerous) => ipcRenderer.invoke('policy-set-global-trust', { confirmDangerous }),
  // 磁盘清理：全局 handler
  cleanupUsage: () => ipcRenderer.invoke('cleanup-usage'),
  cleanupCache: () => ipcRenderer.invoke('cleanup-cache'),
  cleanupAll: () => ipcRenderer.invoke('cleanup-all'),
  // 广播 localStorage 类设置：主进程转发 'settings-changed' 给所有 webContents（含 webview）
  broadcastSettings: (payload) => ipcRenderer.send('shell:settings-broadcast', payload || {}),
  // 软件更新：手动检查（触发 updater.checkForUpdates，弹窗交互在主进程）
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  // API 型 Provider 传输通道（新增）：经主进程向 OpenAI 兼容后端发请求，规避 CORS。
  apiProviderRequest: (opts) => ipcRenderer.invoke('api-provider-request', opts),
  // API 型 Provider 配置（按 profile 持久化，壳层配置条读写）
  apiConfigGet: (profileId) => ipcRenderer.invoke('api-config-get', { profileId }),
  apiConfigSet: (profileId, config) => ipcRenderer.invoke('api-config-set', { profileId, config }),
  // 更新日志：读取解析结果 + 打开弹窗
  getChangelog: () => ipcRenderer.invoke('get-changelog'),
  openChangelog: () => ipcRenderer.invoke('open-changelog'),
});
