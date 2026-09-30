/**
 * IPC 处理器注册（渲染进程 → 主进程）
 * 多窗口版：按 event.sender 路由到对应窗口的 profile 上下文。
 */
const { app, dialog, ipcMain, Notification, webContents } = require('electron');
const { exec } = require('child_process');

const windowState = require('./window');
const profileManager = require('./profile-manager');
const { toolRegistry, jsRunner } = require('./tool-registry');
const { initProject } = require('./project-context');
const { isDangerous } = require('./dangerous-commands');
const { decodeOutput, normalizeCommand } = require('../../tools/decodeOutput');
const { emitWorkerResponse } = require('./team/response-bus');
const apiServer = require('./api-server');
const taskManager = require('./team/task-manager');
const conversationStats = require('./conversation-stats');
const tokenTracker = require('./token-tracker');
const watchdog = require('./watchdog');

/**
 * 解析 Worker 回报的三级暗号
 * @returns {{level:string, content:string}|null}
 */
function parseWorkerReport(text) {
  if (!text || typeof text !== 'string') return null;
  // 解析前先剔除 Markdown 代码围栏（```...```）内的内容：
  // Worker 常在真报告之后贴出含 START/END 字面量的修复代码，
  // 若在原文里找暗号会误抓到代码片段（治本做法，替代此前的 lastIndexOf 权宜之计）。
  const clean = text.replace(/```[\s\S]*?```/g, '');
  const marks = [
    { level: 'DONE', start: '>>>MASTER_DONE_START<<<', end: '>>>MASTER_DONE_END<<<' },
    { level: 'ASK', start: '>>>MASTER_ASK_START<<<', end: '>>>MASTER_ASK_END<<<' },
    { level: 'SYNC', start: '>>>MASTER_SYNC_START<<<', end: '>>>MASTER_SYNC_END<<<' },
  ];
  for (const m of marks) {
    // 取「第一个 START 到其后最近的 END」之间的内容（即第一对暗号）。
    // 真报告的结构是 START + 报告正文 + END，且通常紧跟在第一个 START 之后；
    // 若取最后一对，会被 Worker 复述的暗号说明文字污染。
    const s = clean.indexOf(m.start);
    if (s === -1) continue;
    const e = clean.indexOf(m.end, s + m.start.length);
    if (e === -1) continue;
    return { level: m.level, content: clean.substring(s + m.start.length, e).trim() };
  }
  return null;
}

/** 把剩余秒数格式化为「X天X小时X分」/「X小时X分」/「X分X秒」/「X秒」 */
function formatRemain(sec) {
  if (!sec || sec <= 0) return '0秒';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return d + '天' + h + '小时' + m + '分';
  if (h > 0) return h + '小时' + m + '分';
  if (m > 0) return m + '分' + s + '秒';
  return s + '秒';
}

function registerIpcHandlers() {
  // 初始化项目
  ipcMain.handle('init-project', async (event, { skipPrompt = false, projectDir = null, isCompaction = false } = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    return initProject(skipPrompt, ctx, projectDir, null, isCompaction);
  });

  // 保存全量会话目录（renderer 侧从网页端抓取后回传）
  ipcMain.handle('save-session-catalog', async (event, { conversations } = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    if (!store || typeof store.saveCatalog !== 'function') {
      return { success: false, error: '会话存储不可用' };
    }
    store.saveCatalog(conversations);
    return { success: true, count: Array.isArray(conversations) ? conversations.length : 0 };
  });

  // 列出会话
  ipcMain.handle('list-sessions', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    if (!store) {
      return { success: true, sessions: [], aliases: {}, sessionsMeta: {} };
    }
    const aliases = typeof store.getAliases === 'function' ? store.getAliases() : {};
    const catalog = typeof store.getCatalog === 'function' ? store.getCatalog() : [];
    const dirMap = store.readSessionStore();

    // catalog 为空（还没抓取过）：退回旧逻辑（当前目录的会话），保证向后兼容
    if (!catalog || catalog.length === 0) {
      if (!store.state.selectedProjectDir) {
        return { success: true, sessions: [], aliases, sessionsMeta: {} };
      }
      const sessions = Object.keys(dirMap).filter(id => dirMap[id] === store.state.selectedProjectDir).reverse();
      return { success: true, sessions, aliases, sessionsMeta: {} };
    }

    // 全量：按 catalog 的 updatedAt 倒序，catalog 里没有的（只在 dirMap 的旧会话）追加在后
    const ordered = catalog.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const ids = [];
    const sessionsMeta = {};
    const seen = Object.create(null);
    for (const c of ordered) {
      if (!c || !c.id || seen[c.id]) continue;
      seen[c.id] = true;
      ids.push(c.id);
      sessionsMeta[c.id] = {
        title: c.title || '',
        projectDir: dirMap[c.id] || '',
        updatedAt: c.updatedAt || 0,
        pinned: !!c.pinned,
      };
    }
    // 追加只在 dirMap、catalog 里没有的旧会话（保持创建顺序倒序）
    const leftovers = Object.keys(dirMap).filter(id => !seen[id]).reverse();
    for (const id of leftovers) {
      seen[id] = true;
      ids.push(id);
      sessionsMeta[id] = { title: '', projectDir: dirMap[id] || '', updatedAt: 0, pinned: false };
    }
    return { success: true, sessions: ids, aliases, sessionsMeta };
  });

  // 查询当前项目目录（preload 启动时主动拉取，避免错过 project-dir-updated 推送）
  ipcMain.handle('get-project-dir', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    const dir = store ? (store.state.selectedProjectDir || store.state.pendingProjectDir || null) : null;
    return { success: true, dir };
  });

  // 重命名会话（本地别名，仅影响壳层会话列表显示，不回写网页端标题）
  ipcMain.handle('rename-session', async (event, { sessionId, alias } = {}) => {
    if (!sessionId) return { success: false, error: '缺少会话ID' };
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    if (!store || typeof store.saveAlias !== 'function') {
      return { success: false, error: '会话存储不可用' };
    }
    store.saveAlias(sessionId, alias);
    // 跨窗口同步：广播给所有渲染上下文（各 webview + 壳窗口）。
    // 各窗口 preload 收到后对网页端执行重命名；壳层收到后刷新会话列表。
    // 注意：webview 内 renameRemoteSession 只操作页面 DOM，不触发本 IPC，无循环风险。
    try {
      for (const wc of webContents.getAllWebContents()) {
        if (wc && !wc.isDestroyed()) wc.send('session-renamed', { sessionId, alias });
      }
    } catch (_) {}
    return { success: true };
  });

  // 导航到会话
  ipcMain.handle('navigate-session', async (event, { sessionId }) => {
    if (!sessionId) return { success: false, error: '缺少会话ID' };
    const ctx = windowState.getContextByWebContents(event.sender);
    const win = ctx ? ctx.win : null;
    if (!win || win.isDestroyed()) return { success: false, error: '窗口已关闭' };
    // 按当前 provider 拼会话 URL（智谱 cid=、DeepSeek /chat/s/、Claude /chat/）
    let url = null;
    try {
      const { getProviderByUrl } = require('../providers');
      const provider = getProviderByUrl(win.webContents.getURL());
      if (provider && typeof provider.sessionUrlBase === 'string' && provider.sessionUrlBase) {
        url = provider.sessionUrlBase + sessionId;
      }
    } catch (_) { /* 回退 DeepSeek */ }
    if (!url) url = 'https://chat.deepseek.com/a/chat/s/' + sessionId;
    try {
      await win.webContents.loadURL(url);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 执行命令
  ipcMain.handle('execute-command', async (event, { command, id }) => {
    if (!command || typeof command !== 'string') {
      return { id, success: false, error: '无效的命令' };
    }
    const trimmed = normalizeCommand(command.trim());
    if (!trimmed) return { id, success: false, error: '命令为空' };

    const ctx = windowState.getContextByWebContents(event.sender);
    const win = ctx ? ctx.win : windowState.getMainWindow();
    const store = ctx ? ctx.sessionStore : null;
    const selectedDir = store ? store.state.selectedProjectDir : null;

    const dangerWarning = isDangerous(trimmed) ? '\n\n⚠️ 警告：此命令可能存在风险，请谨慎确认！' : '';
    const result = await dialog.showMessageBox(win, {
      type: isDangerous(trimmed) ? 'warning' : 'question',
      buttons: ['取消', '确认执行'],
      defaultId: 0,
      cancelId: 0,
      title: '确认执行命令',
      message: '将执行以下命令：',
      detail: trimmed + dangerWarning,
    });
    if (result.response !== 1) {
      return { id, success: false, error: '用户取消了执行', canceled: true };
    }
    return new Promise((resolve) => {
      const child = exec(
        trimmed,
        {
          cwd: selectedDir || process.env.USERPROFILE || app.getPath('home'),
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          encoding: 'buffer',
        },
        (error, stdout, stderr) => {
          resolve({
            id,
            success: !error,
            stdout: decodeOutput(stdout),
            stderr: decodeOutput(stderr),
            error: error ? error.message : null,
          });
        }
      );
    });
  });

  // 执行工具
  ipcMain.handle('execute-tool', async (event, { toolName, params, callId }) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    const selectedDir = store ? store.state.selectedProjectDir : null;
    try {
      const result = await toolRegistry.execute(toolName, { ...params, projectDir: selectedDir, __callerProfileId: ctx ? ctx.profileId : null });
      return { callId, success: result.success, data: result.data, error: result.error };
    } catch (err) {
      return { callId, success: false, error: err.message };
    }
  });

  // AI 回复完成时：壳窗口已聚焦则不打扰；否则弹通知并让壳窗口任务栏/Dock 闪烁。
  // 说明（多标签架构）：每个标签是 webview，被包装成"类 BrowserWindow 适配器"（ctx.win），
  // 其 isFocused() 仅反映 webContents 焦点、flashFrame() 是空实现——都不能代表
  // "用户是否在看本应用/这个标签"。故统一以壳窗口（真实 BrowserWindow）为准。
  ipcMain.handle('show-ai-notification', async (event) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      let shellWin = null;
      try { shellWin = windowState.getShellWindow(); } catch (_) {}
      const fallbackWin = ctx ? ctx.win : windowState.getMainWindow();

      // 总闸：以壳窗口是否聚焦判断用户是否正在使用本应用（聚焦=不打扰）
      let focused = false;
      if (shellWin && !shellWin.isDestroyed()) {
        try { focused = shellWin.isFocused(); } catch (_) { focused = false; }
      } else if (fallbackWin && !fallbackWin.isDestroyed()) {
        try { focused = fallbackWin.isFocused(); } catch (_) { focused = false; }
      }
      if (focused) {
        try { if (shellWin && !shellWin.isDestroyed()) shellWin.flashFrame(false); } catch (_) {}
        return { success: true, skipped: true, reason: 'shell-focused' };
      }

      // 组织通知标题：程序名固定为 TokFree，profile 名作为补充
      {
        let windowName = 'TokFree';
        if (ctx && ctx.profileId) {
          try {
            const profile = profileManager.getProfileById(ctx.profileId);
            if (profile && profile.name) windowName = profile.name;
          } catch (_) {}
        }
        const title = windowName === 'TokFree'
          ? 'TokFree - AI任务已完成'
          : ('TokFree · ' + windowName + ' - AI任务已完成');

        const notification = new Notification({
          title: title,
          body: 'AI 已完成回复',
        });
        try { notification.show(); } catch (e) { console.error('[TokFree] 系统通知发送失败:', e && e.message); }

        // 任务栏闪烁必须用壳窗口（webview 适配器 flashFrame 为空实现）
        try {
          const flashTarget = (shellWin && !shellWin.isDestroyed()) ? shellWin : (fallbackWin && !fallbackWin.isDestroyed() && typeof fallbackWin.flashFrame === 'function' ? fallbackWin : null);
          if (flashTarget) {
            flashTarget.flashFrame(true);
            flashTarget.once('focus', () => {
              try { if (!flashTarget.isDestroyed()) flashTarget.flashFrame(false); } catch (_) {}
            });
          }
        } catch (_) {}
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // AI 协作：Worker 确认已收到派发任务（双向确认 ack）
  // 主进程在派发时登记等待 ack；收到此确认即标记 task.ackAt，并清除超时定时器。
  ipcMain.handle('worker-task-ack', async (event, { taskId } = {}) => {
    try {
      if (!taskId) return { success: false, error: '缺少 taskId' };
      const ok = taskManager.markTaskAck(taskId);
      if (ok) {
        try {
          const { clearAckTimer } = require('./team/dispatch');
          clearAckTimer(taskId);
        } catch (_) {}
      }
      return { success: ok };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // AI 协作：接收 Worker 窗口上报的完整回复
  // 支持三级暗号：SYNC(进度) / DONE(完成) / ASK(求助)，解析后写入事件账本并入收件队列。
  ipcMain.handle('report-ai-response', async (event, { text, taskId } = {}) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);

      // 解析三级暗号，返回 { level, content } 或 null
      const parsed = parseWorkerReport(text);

      if (taskId && parsed) {
        // 写入事件账本
        taskManager.appendReport(taskId, { level: parsed.level, content: parsed.content });
        // DONE：标记完成
        if (parsed.level === 'DONE') {
          taskManager.updateTaskStatus(taskId, 'COMPLETED', parsed.content);
          // 推进编排计划：对应模块标记完成，解锁下游依赖
          try { require('./team/plan').markDoneByTaskId(taskId, parsed.content); } catch (_) {}
        } else {
          // SYNC / ASK：保持绑定（不清空），状态置 WAITING_MASTER
          taskManager.updateTaskStatus(taskId, 'WAITING_MASTER', parsed.content);
        }
        // 入收件队列（由队列负责合并 + 唤醒主大脑）
        try {
          const { enqueue } = require('./team/report-queue');
          enqueue({ taskId, level: parsed.level, content: parsed.content });
        } catch (e) {
          console.error('[ReportQueue] 入队失败:', e.message);
        }
        return { success: true, synced: true, level: parsed.level };
      }

      if (!ctx) {
        return { success: false, error: '窗口上下文不存在' };
      }

      const ok = emitWorkerResponse({
        profileId: ctx.profileId,
        providerId: ctx.providerId,
        taskId: taskId || '',
        text: typeof text === 'string' ? text : '',
        finished: true,
      });

      return { success: ok };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 本地 OpenAI 兼容 API 服务：接收网页 AI 回复 ==========
  // preload 收到 AI 的普通文本回复后回传此处，用 requestId 关联并 resolve 挂起的 HTTP 请求。
  // 可选：从 event.sender 反查 profileId 做来源校验（不匹配仅告警，不阻断，避免误伤）。
  ipcMain.handle('api-response', async (event, { requestId, text } = {}) => {
    try {
      if (!requestId) return { success: false, error: '缺少 requestId' };
      try {
        const ctx = windowState.getContextByWebContents(event.sender);
        if (ctx && ctx.profileId) {
          // 仅日志留痕：便于排查"回复来自哪个窗口"
          console.log('[ApiServer] 收到回复 profile=' + ctx.profileId + ' requestId=' + requestId);
        }
      } catch (_) {}
      const ok = apiServer.resolveWait(requestId, typeof text === 'string' ? text : '');
      return { success: ok };
    } catch (err) {
      return { success: false, error: (err && err.message) || String(err) };
    }
  });

  // ========== AI 协作：Team 调度相关 ==========
  
  // 获取所有可用的 Worker (Profile 列表)
  ipcMain.handle('team-list-workers', async () => {
    try {
      const profiles = profileManager.readProfiles();
      // 多标签架构：标签 profile 默认绑定平台；旧数据可能 providerId 为空。
      // 不再按 providerId 过滤——返回全部 profile 并标注是否已打开（打开 = 可作为 Worker 派发）。
      const workers = profiles.map(p => ({
        ...p,
        open: !!windowState.getWindowByProfileId(p.id),
      }));
      // 已打开的排前面，主 Agent 优先选已打开的 Worker
      workers.sort((a, b) => (b.open ? 1 : 0) - (a.open ? 1 : 0));
      return { success: true, workers };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 派发任务给指定的 Worker 窗口（自动开新对话 + 初始化项目上下文 + 发送任务）
  ipcMain.handle('team-dispatch-task', async (event, { profileId, prompt, projectDir, module, waveId }) => {
    try {
      const { dispatchTask } = require('./team/dispatch');
      // 判定主大脑：发起派发的窗口
      const senderCtx = windowState.getContextByWebContents(event.sender);
      const masterProfileId = senderCtx ? senderCtx.profileId : '';
      // 确保收件队列已启动
      try { require('./team/report-queue').start(); } catch (_) {}
      return await dispatchTask(profileId, prompt, projectDir, { module, waveId, masterProfileId });
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 查询任务状态
  ipcMain.handle('team-get-task-status', async (event, { taskId }) => {
    try {
      const task = taskManager.getTask(taskId);
      if (!task) return { success: false, error: '任务不存在' };
      return { success: true, task };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== AI 协作：Team UI 调度台 ==========
  ipcMain.handle('team-show-dispatch-ui', async () => {
    try {
      const { BrowserWindow } = require('electron');
      const path = require('path');
      const profiles = profileManager.readProfiles();
      const ctxs = windowState.getAllContexts();
      const workers = ctxs.map(c => {
        const p = profiles.find(x => x.id === c.profileId);
        return {id:c.profileId, name:p?p.name:'', providerId:c.providerId};
      }).filter(x=>x.id);

      return new Promise((resolve) => {
        const uiWin = new BrowserWindow({
          width: 500, height: 600, title: 'Worker 调度台',
          parent: windowState.getMainWindow() || undefined,
          modal: false,
          // 此处加载本地 HTML（调度台），非远程内容，故放宽隔离；勿改为加载远程 URL
          webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
        });
        uiWin.loadFile(path.join(__dirname, 'team', 'dispatch-ui.html'));
        uiWin.webContents.on('did-finish-load', () => {
          uiWin.webContents.send('init-workers', workers);
        });

        ipcMain.once('ui-dispatch-task', async (event, { profileId, prompt }) => {
          const ctx = windowState.getWindowByProfileId(profileId);
          if (!ctx || !ctx.win) { resolve({success:false, error:'窗口未打开'}); uiWin.close(); return; }
          const task = taskManager.createTask(profileId, prompt);
          taskManager.updateTaskStatus(task.id, 'DISPATCHED');
          ctx.win.webContents.send('worker-dispatch-task', {taskId:task.id, prompt:prompt});
          resolve({success:true, taskId:task.id});
          uiWin.close();
        });
        uiWin.on('closed', () => resolve({success:false, error:'用户关闭窗口'}));
      });
    } catch (err) { return { success: false, error: err.message }; }
  });
  // ========== 多 Agent 模式开关 ==========
  ipcMain.handle('get-team-mode', async (event) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      const mode = require('./team/mode').getMode(ctx ? ctx.profileId : null);
      return { success: true, mode };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('set-team-mode', async (event, { mode } = {}) => {
    try {
      const ctx0 = windowState.getContextByWebContents(event.sender);
      const m = require('./team/mode').setMode(mode, ctx0 ? ctx0.profileId : null);
      // 自动角色绑定：开启多Agent→本窗口标 master；关闭→清除角色
      try {
        const pm = require('./profile-manager');
        const pid = ctx0 ? ctx0.profileId : null;
        if (pid) {
          const rm = require('./team/role-manager');
          if (m === 'multi') rm.setMaster(pid);
          else rm.clearRole(pid);
        }
      } catch (_) {}
      // 运行时切换：主动发一条系统消息告知 AI 当前模式已变
      const ctx = windowState.getContextByWebContents(event.sender);
      const notify = m === 'multi'
        ? '【模式切换】已开启「多 Agent 模式」。从现在起你作为主大脑（总经理）：复杂/多模块/需规划的工作拆解后派发给子 Agent，你负责规划、派发、审阅、验收与决策；简单线性问题或极小修补可自己做。可用 team_* 工具调度。'
        : '【模式切换】已关闭「多 Agent 模式」，回到「单聊模式」。你直接独立完成任务，无需调度其他窗口。';
      if (ctx && ctx.win && !ctx.win.isDestroyed()) {
        ctx.win.webContents.send('master-inject-message', { message: notify });
      }
      return { success: true, mode: m };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 手动设置窗口角色（主大脑 / 子Agent / 清除） ==========
  ipcMain.handle('set-profile-role', async (event, { profileId, role, belongTo } = {}) => {
    try {
      if (!profileId) return { success: false, error: '缺少 profileId' };
      const rm = require('./team/role-manager');
      if (role === 'master') {
        rm.setMaster(profileId);
        // 同步开启多 Agent 模式，让标签和行为一致
        try { require('./team/mode').setMode('multi', profileId); } catch (_) {}
        // 发系统消息告知 AI 模式已变（复用 set-team-mode 的通知逻辑）
        try {
          const ctx = windowState.getWindowByProfileId(profileId);
          if (ctx && ctx.win && !ctx.win.isDestroyed()) {
            ctx.win.webContents.send('master-inject-message', { message: '【模式切换】你已被设为主大脑。从现在起你作为主大脑（总经理）：复杂/多模块/需规划的工作拆解后派发给子 Agent，你负责规划、派发、审阅、验收与决策；简单线性问题或极小修补可自己做。可用 team_* 工具调度。' });
          }
        } catch (_) {}
      } else if (role === 'worker') {
        rm.setWorker(profileId, belongTo || '');
      } else {
        rm.clearRole(profileId);
        // 清除角色时，若该窗口已无其它角色，可选择性关多Agent模式（保守：不动 mode，避免误关）
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 工作模式（Plan/Act）+ 操作确认 ==========
  ipcMain.handle('policy-get', async (event) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      const policy = require('./tool-policy');
      return { success: true, policy: policy.getPolicy(ctx ? ctx.profileId : null) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('policy-set-mode', async (event, { mode } = {}) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      const policy = require('./tool-policy');
      policy.setMode(mode, ctx ? ctx.profileId : null);
      return { success: true, policy: policy.getPolicy(ctx ? ctx.profileId : null) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('policy-set-trust', async (event, { confirmDangerous } = {}) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      const policy = require('./tool-policy');
      policy.setConfirmDangerous(confirmDangerous, ctx ? ctx.profileId : null);
      return { success: true, policy: policy.getPolicy(ctx ? ctx.profileId : null) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 命令策略（allow/confirm/deny 三级） ==========
  ipcMain.handle('command-policy-get', async () => {
    try {
      const commandPolicy = require('./command-policy');
      return { success: true, config: commandPolicy.getConfig() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('command-policy-add', async (_event, { rule } = {}) => {
    try {
      const commandPolicy = require('./command-policy');
      const added = commandPolicy.addRule(rule);
      return { success: true, rule: added, config: commandPolicy.getConfig() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('command-policy-remove', async (_event, { id } = {}) => {
    try {
      const commandPolicy = require('./command-policy');
      const removed = commandPolicy.removeRule(id);
      return { success: removed, config: commandPolicy.getConfig() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('command-policy-set', async (_event, { rules } = {}) => {
    try {
      const commandPolicy = require('./command-policy');
      const saved = commandPolicy.setRules(rules);
      return { success: true, rules: saved, config: commandPolicy.getConfig() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  // 全局默认（设置面板用）：写入 __global__，影响所有未单独覆盖的标签
  ipcMain.handle('policy-set-global-trust', async (_event, { confirmDangerous } = {}) => {
    try {
      const policy = require('./tool-policy');
      policy.setGlobalTrust(confirmDangerous);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('policy-set-global-mode', async (_event, { mode } = {}) => {
    try {
      const policy = require('./tool-policy');
      policy.setGlobalMode(mode);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('policy-get-global', async () => {
    try {
      const policy = require('./tool-policy');
      // 读取全局默认本身（不带 profile 覆盖）：直接用 __global__ 条目
      const all = policy.getPolicy('__no_such_profile__'); // 回退到 __global__/DEFAULT
      return { success: true, policy: all };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  // ===== 壳层专用（壳窗口 sender 非 webview，需显式传 profileId）=====
  ipcMain.handle('shell:policy-get', async (_event, { profileId } = {}) => {
    try {
      const policy = require('./tool-policy');
      return { success: true, policy: policy.getPolicy(profileId || null) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('shell:policy-set-trust', async (_event, { profileId, confirmDangerous } = {}) => {
    try {
      const policy = require('./tool-policy');
      policy.setConfirmDangerous(confirmDangerous, profileId || null);
      return { success: true, policy: policy.getPolicy(profileId || null) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('shell:policy-set-mode', async (_event, { profileId, mode } = {}) => {
    try {
      const policy = require('./tool-policy');
      policy.setMode(mode, profileId || null);
      return { success: true, policy: policy.getPolicy(profileId || null) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('shell:policy-get-global', async () => {
    try {
      const policy = require('./tool-policy');
      return { success: true, policy: policy.getPolicy('__no_such_profile__') };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  // 标签后台节流：非活动标签的 webview 启用 Chromium 节流（省 CPU/内存），活动标签关闭节流（响应流畅）。
  // 全局 webPreferences 是 backgroundThrottling:false（不主动节流），这里按标签显式覆盖 guest webContents。
  // 壳窗口 sender 非 webview，需显式传 profileId（经 windowState 反查 guest webContents）。
  ipcMain.handle('shell:set-tab-throttled', async (_event, { profileId, throttled } = {}) => {
    try {
      if (!profileId) return { success: false, error: 'profileId 为空' };
      const ctx = windowState.getWindowByProfileId(profileId);
      const wc = ctx && ctx.win && ctx.win.webContents;
      if (!wc || typeof wc.setBackgroundThrottling !== 'function') {
        return { success: false, error: 'webContents 不可用' };
      }
      wc.setBackgroundThrottling(!!throttled);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  // ========== 软件更新（手动检查入口） ==========
  // updater 顶层 require electron-updater（惰性 require 避免启动期问题）。
  // checkForUpdates 内部自带弹窗交互（新版本/已最新/失败），此处只需触发并容错。
  ipcMain.handle('check-update', async () => {
    try {
      const updater = require('./updater');
      updater.checkForUpdates().catch((err) => {
        console.error('[TokFree] 检查更新失败:', err && err.message);
      });
      return { success: true };
    } catch (err) {
      console.error('[TokFree] 触发检查更新异常:', err && err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('tool-confirm-response', async (_event, { requestId, ok } = {}) => {
    try {
      const confirm = require('./tool-confirm');
      const handled = confirm.respondConfirm(requestId, ok);
      return { success: handled };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 执行 JS 脚本
  ipcMain.handle('execute-js', async (event, { code, callId }) => {
    if (!code || typeof code !== 'string') {
      return { callId, success: false, error: '无效的 JS 代码' };
    }
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    const selectedDir = store ? store.state.selectedProjectDir : null;
    try {
      const result = await jsRunner.run(code, selectedDir, ctx ? ctx.profileId : null);
      // master-guard: detect master doing work itself in multi-agent mode
      try {
        const mg = require('./team/master-guard');
        const g = mg.noteSelfWork(ctx ? ctx.profileId : null, code);
        if (g.shouldNudge && ctx) {
          const gctx = windowState.getWindowByProfileId(ctx.profileId);
          if (gctx && gctx.win && !gctx.win.isDestroyed()) {
            gctx.win.webContents.send('master-inject-message', { message: mg.buildNudge() });
            console.log('[MasterGuard] nudge master to dispatch, profile=' + ctx.profileId);
          }
        }
      } catch (_) {}
      return { callId, ...result };
    } catch (err) {
      return { callId, success: false, error: err.message };
    }
  });

  // 站点原生发送：向聚焦输入框注入真实级 Enter（智谱只响应 isTrusted=true 的输入，合成事件免疫）
  // ⚠️ 多标签架构下 Worker 常是后台标签 / 被 #chat-view 遮住的 webview：
  //    webContents 未聚焦时 sendInputEvent 注入的按键不会进入页面（消息卡输入框）。
  //    故发送前先聚焦目标 webContents；若能反查宿主 BrowserWindow，一并 focus。
  ipcMain.handle('chat-send-enter', async (event) => {
    const sender = event.sender;
    if (!sender || sender.isDestroyed()) return false;
    // 1) 聚焦目标 webContents（webview 未聚焦时按键无效，必须先聚焦）
    try { if (typeof sender.focus === 'function') sender.focus(); } catch (_) {}
    console.log('[TokFree] chat-send-enter focus=' + (typeof sender.isFocused === 'function' ? sender.isFocused() : 'n/a'));
    // 2) 兜底：反查该 webContents 所在的宿主窗口并聚焦，确保按键真正送达
    //    ⚠️ Electron 要求 webContents 所属窗口处于聚焦状态，sendInputEvent 才会生效；
    //    多标签架构下每个标签是 webview，真正的 BrowserWindow 是壳窗口，故一并聚焦。
    try {
      const ctx = windowState.getContextByWebContents(sender);
      const hostWin = ctx && ctx.win;
      if (hostWin && !hostWin.isDestroyed()) {
        try { if (typeof hostWin.focus === 'function') hostWin.focus(); } catch (_) {}
        try { if (hostWin.webContents && typeof hostWin.webContents.focus === 'function') hostWin.webContents.focus(); } catch (_) {}
      }
      // 聚焦壳窗口（唯一真实 BrowserWindow），保证 Electron 层满足 sendInputEvent 的聚焦前提
      try {
        const shell = windowState.getShellWindow && windowState.getShellWindow();
        if (shell && !shell.isDestroyed()) shell.focus();
      } catch (_) {}
    } catch (_) {}
    // 3) 注入原生 Enter（keyDown → char → keyUp）
    try {
      sender.sendInputEvent({ type: 'keyDown', keyCode: 'Return', key: 'Enter' });
      sender.sendInputEvent({ type: 'char', keyCode: 'Return', key: '\r' });
      sender.sendInputEvent({ type: 'keyUp', keyCode: 'Return', key: 'Enter' });
      return true;
    } catch (err) {
      console.error('[TokFree] ❌ 原生 Enter 发送失败:', err.message);
      return false;
    }
  });

  // 会话收发计数：渲染进程上报一次发送/接收
  ipcMain.handle('record-conversation', async (event, { type } = {}) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      if (!ctx) return { success: false, error: '窗口上下文不存在' };
      const stats = conversationStats.record(ctx.profileId, type === 'received' ? 'received' : 'sent');
      return { success: true, stats };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 子 Agent token 用量上报：渲染进程在收到回复时上报，主进程按 profile 存储
  ipcMain.handle('report-token-usage', async (event, { count } = {}) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      if (!ctx) return { success: false, error: '窗口上下文不存在' };
      tokenTracker.setTokenCount(ctx.profileId, count);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Token 增量上报：渲染进程在收到回复时上报本次增量，主进程按天累计到会话统计
  ipcMain.handle('report-token-delta', async (event, { delta } = {}) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      if (!ctx) return { success: false, error: '窗口上下文不存在' };
      const rec = conversationStats.addTokens(ctx.profileId, delta);
      return { success: true, stats: rec };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 用量汇总：按窗口 / 按天 聚合统计（今日 / 本周 / 各窗口明细）
  ipcMain.handle('stats-summary', async (event, { days } = {}) => {
    try {
      return { success: true, data: conversationStats.getSummary({ days }) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Token 用量汇总：今日 / 本周 / 总计 + 每日序列（供柱状图）
  ipcMain.handle('stats-token', async (event, { days } = {}) => {
    try {
      return { success: true, data: conversationStats.getTokenStats({ days }) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 任务计时上报（方案B）：壳层胶囊 onActiveChange true→false 时上报本轮任务时长
  ipcMain.handle('report-task-duration', async (_event, { durationMs, profileId } = {}) => {
    try {
      return { success: true, data: conversationStats.recordTaskDuration(durationMs, profileId) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ZCode 风格使用统计：KPI + 热力图 + 趋势折线 + 按窗口饼图
  ipcMain.handle('shell:usage-stats', async (event, { mode, rangeDays } = {}) => {
    try {
      return { success: true, data: conversationStats.getUsageStats({ mode, rangeDays }) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 数据看板（metrics-store 指标读取）==========
  // 按 profileId + date 聚合的 token / 任务指标。壳窗口 sender 不是 webview，
  // 故 profileId 一律显式传入（空串 = 汇总所有 profile）。
  ipcMain.handle('metrics-daily', async (event, { profileId, date } = {}) => {
    try {
      const metricsStore = require('./metrics-store');
      return { success: true, data: metricsStore.getDaily(profileId || '', date || null) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('metrics-range', async (event, { profileId, from, to } = {}) => {
    try {
      const metricsStore = require('./metrics-store');
      return { success: true, data: metricsStore.getRange(profileId || '', from, to) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('metrics-summary', async (event, { profileId } = {}) => {
    try {
      const metricsStore = require('./metrics-store');
      return { success: true, data: metricsStore.getSummary(profileId || '') };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 看门狗 IPC ==========
  // 开始等待 AI 回复（arm，进入监护）
  ipcMain.handle('watchdog-arm', async (event, { reset } = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (ctx) watchdog.arm(ctx.profileId, reset);
    return { success: !!ctx };
  });
  // 流活动：仅已进入监护时刷新心跳（不重新武装）
  ipcMain.handle('watchdog-touch', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (ctx) watchdog.touch(ctx.profileId);
    return { success: !!ctx };
  });
  // AI 已回复（disarm，退出监护）
  ipcMain.handle('watchdog-replied', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (ctx) watchdog.disarm(ctx.profileId);
    return { success: !!ctx };
  });
  // 已检测到中断/截断（保持监护，并用更短超时催促）
  ipcMain.handle('watchdog-interrupted', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (ctx) watchdog.markInterrupted(ctx.profileId);
    return { success: !!ctx };
  });
  // 按钮回到「发送」态（本轮生成结束/中断）：辅助判断，漏完成事件时加速催促
  ipcMain.handle('watchdog-button-idle', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (ctx) watchdog.noteButtonIdle(ctx.profileId);
    return { success: !!ctx };
  });
  // AI 完成一条纯文本回复（无 JS 代码块/工具调用）：进入完成确认模式
  ipcMain.handle('watchdog-schedule-confirm', async (event, { text } = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false };
    return { success: watchdog.scheduleConfirm(ctx.profileId, text) };
  });
  // 标记长任务（busy）
  ipcMain.handle('watchdog-busy', async (event, { note, secs } = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '窗口上下文不存在' };
    watchdog.setBusy(ctx.profileId, note, secs);
    return { success: true };
  });
  // 清除 busy
  ipcMain.handle('watchdog-clear-busy', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '窗口上下文不存在' };
    watchdog.clearBusy(ctx.profileId);
    return { success: true };
  });
  // 查询看门狗状态
  ipcMain.handle('watchdog-status', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    return { success: true, status: watchdog.getStatus(ctx ? ctx.profileId : null) };
  });
  // 汇总所有窗口状态（供窗口管理面板一眼看清各 AI 在干嘛）
  ipcMain.handle('list-windows-status', async () => {
    try {
      const profiles = profileManager.readProfiles();
      const ctxs = windowState.getAllContexts();
      const active = ['PENDING', 'DISPATCHED', 'RUNNING', 'WAITING_MASTER'];
      // 遍历所有 profiles（含已关闭窗口）：禁言状态持久化在 profile 上，关闭后仍可见
      const now = Date.now();
      const list = profiles.map((pr) => {
        const c = ctxs.find((x) => x.profileId === pr.id);  // 可能 undefined（已关闭）
        const st = c ? watchdog.getStatus(pr.id) : null;
        const p = (st && st.profile) || {};
        // 当前任务（仅窗口打开时有意义）
        let curTask = null;
        try {
          if (c) {
            const t = taskManager.listTasks().find((x) => x.profileId === pr.id && active.indexOf(x.status) !== -1);
            if (t) curTask = { taskId: t.id, module: t.module, status: t.status };
          }
        } catch (_) {}

        // 禁言状态：从 profile 持久化读取（窗口关闭后仍保留；过期自动清理）
        let banned = null;
        try { banned = profileManager.getProfileBanned(pr.id); } catch (_) {}

        // role/belongTo：走 role-manager 统一判定（动态优先）
        let role = '', belongTo = '';
        try {
          const rm = require('./team/role-manager');
          const r = rm.getRole(pr.id);
          role = r.role; belongTo = r.belongTo;
        } catch (_) {}

        // 推导状态标签
        let label = '空闲';
        let tone = 'idle';
        const monitoring = !!p.expectingReply;

        // ⚠️ 未选平台 / 未登录：应显示真实状态，而非"空闲"
        const noProvider = !pr.providerId;   // profile 未选平台（停在平台选择页）

        // 状态优先级（从高到低）：
        //   禁言（持久化）> 未打开 > 未选平台 > 未登录 > 限流冷却 > 长任务 > 中断 > 生成中 > 执行任务 > 空闲
        let banRemainSec = 0;
        if (banned) {
          if (banned.until && banned.until > now) {
            banRemainSec = Math.round((banned.until - now) / 1000);
          }
          label = banned.until
            ? ('账号受限（剩余 ' + formatRemain(banRemainSec) + '）')
            : '账号受限（无解除时间）';
          tone = 'banned';
        }
        else if (!c) { label = '未打开'; tone = 'idle'; }
        else if (noProvider) { label = '未选平台'; tone = 'warn'; }
        else if (pr.pageState === 'login') { label = '未登录'; tone = 'warn'; }
        else if (p.cooldownRemain > 0) { label = '限流冷却 ' + p.cooldownRemain + 's'; tone = 'warn'; }
        else if (p.busy) { label = '长任务中' + (p.busyNote ? '（' + p.busyNote + '）' : ''); tone = 'busy'; }
        else if (monitoring && p.interrupted) { label = '已中断，待恢复'; tone = 'warn'; }
        else if (monitoring) { label = '思考/生成中'; tone = 'busy'; }
        else if (curTask) { label = '执行任务中：' + (curTask.module || curTask.taskId); tone = 'busy'; }

        return {
          profileId: pr.id,
          name: pr.name || '',
          providerId: pr.providerId,
          open: !!c,
          role: role,
          belongTo: belongTo,
          state: tone,          // idle | busy | warn | banned
          label,                // 中文状态描述
          expectingReply: !!p.expectingReply,
          busy: !!p.busy,
          interrupted: !!p.interrupted,
          cooldownRemain: p.cooldownRemain || 0,
          heartbeatAge: p.heartbeatAge || 0,
          currentTask: curTask,
          banned: !!banned,
          banRemainSec: banRemainSec,
          banUntil: (banned && banned.until) || 0,
        };
      });
      return { success: true, windows: list };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  // 手动唤醒
  ipcMain.handle('watchdog-wake-now', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false, error: '窗口上下文不存在' };
    return watchdog.wakeNow(ctx.profileId);
  });
  // 记录命中限流（渲染进程检测到限流文案时调用）
  ipcMain.handle('watchdog-note-ratelimit', async (event, { hitWord } = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (ctx) watchdog.noteRateLimit(ctx.profileId, hitWord);
    return { success: !!ctx };
  });
  // 记录账号被禁言/封禁（渲染进程检测到页面提示时调用）
  // 同时写入 watchdog 内存 + profile 持久化（窗口关闭后仍保留）
  ipcMain.handle('watchdog-note-banned', async (event, info = {}) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false };
    watchdog.noteBanned(ctx.profileId, info);
    try { profileManager.setProfileBanned(ctx.profileId, info); } catch (_) {}
    return { success: true };
  });
  // 清除禁言状态（提示消失时调用）
  ipcMain.handle('watchdog-clear-banned', async (event) => {
    const ctx = windowState.getContextByWebContents(event.sender);
    if (!ctx) return { success: false };
    watchdog.clearBanned(ctx.profileId);
    try { profileManager.clearProfileBanned(ctx.profileId); } catch (_) {}
    return { success: true };
  });
  // 暂停/恢复看门狗
  ipcMain.handle('watchdog-set-paused', async (_event, { paused } = {}) => {
    watchdog.updateConfig({ paused: !!paused });
    return { success: true, paused: !!paused };
  });
  // 渲染进程上报页面状态（login=在登录页 / home=平台首页 / ready=已进入对话）
  ipcMain.handle('report-page-state', async (event, { state } = {}) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      if (ctx && ctx.profileId) {
        profileManager.updateProfile(ctx.profileId, { pageState: String(state || '') });
      }
      return { success: true };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // ========== 应用级设置（全局，跨窗口统一）==========
  ipcMain.handle('set-theme', async (_event, { theme } = {}) => {
    try {
      const t = require('./settings').setTheme(theme);
      // 统一真源：变更后广播到所有 webContents（含 webview），保证壳层/标签一致
      try {
        for (const wc of webContents.getAllWebContents()) {
          if (wc && !wc.isDestroyed()) wc.send('theme-changed', { theme: t });
        }
      } catch (_) {}
      return { success: true, theme: t };
    } catch (err) { return { success: false, error: err.message }; }
  });
  ipcMain.handle('get-theme', async () => {
    try { return { success: true, theme: require('./settings').getTheme() }; }
    catch (err) { return { success: false, error: err.message }; }
  });
  // 回执发送延迟（全局，跨标签共享）
  ipcMain.handle('get-send-delay', async () => {
    try {
      const d = require('./settings').getSendDelay();
      return { success: true, min: d.min, max: d.max };
    } catch (err) { return { success: false, error: err.message }; }
  });
  ipcMain.handle('set-send-delay', async (_event, { min, max } = {}) => {
    try {
      const nMin = parseInt(min, 10);
      const nMax = parseInt(max, 10);
      if (isNaN(nMin) || nMin < 0) return { success: false, error: '最小延迟必须是非负整数' };
      if (isNaN(nMax) || nMax < nMin) return { success: false, error: '最大延迟不能小于最小延迟' };
      if (nMax > 10000) return { success: false, error: '最大延迟不能超过 10000ms' };
      const d = require('./settings').setSendDelay(nMin, nMax);
      return { success: true, min: d.min, max: d.max };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // 启用/禁用看门狗（生命监护总开关）
  ipcMain.handle('watchdog-set-enabled', async (_event, { enabled } = {}) => {
    watchdog.updateConfig({ enabled: !!enabled });
    return { success: true, enabled: !!enabled };
  });
  // 读看门狗配置（供设置面板显示）
  ipcMain.handle('watchdog-get-config', async () => {
    return { success: true, config: watchdog.getConfig() };
  });

  // ========== 壳层全局设置：把 localStorage 类设置广播给所有 webview ==========
  // 壳窗口只有一个，其 localStorage 天然全局；但各 webview（标签）有自己的 localStorage，
  // 故壳层保存后经主进程转发 'settings-changed'，由 webview preload 写入各自 localStorage。
  ipcMain.on('shell:settings-broadcast', (_event, payload = {}) => {
    try {
      for (const wc of webContents.getAllWebContents()) {
        if (wc && !wc.isDestroyed()) wc.send('settings-changed', payload);
      }
    } catch (_) {}
  });

  // ========== 壳层窗口管理专用（显式 profileId，不依赖 sender ctx）==========
  // 壳窗口不是 webview：getContextByWebContents(event.sender) 返回 null，
  // 故这些 handler 从参数显式取 profileId（看门狗区在壳层全局面板中按当前标签定位）。
  ipcMain.handle('shell:watchdog-status', async (_event, { profileId } = {}) => {
    return { success: true, status: watchdog.getStatus(profileId || null) };
  });
  ipcMain.handle('shell:watchdog-wake-now', async (_event, { profileId } = {}) => {
    if (!profileId) return { success: false, error: '缺少 profileId' };
    return watchdog.wakeNow(profileId);
  });

  // ========== 引导者（Curator）驱动器 IPC ==========
  const curator = require('./team/curator');
  const evolutionSwitch = require('./team/evolution-switch');

  // 自进化飞轮总开关（含引导者/自驱循环/自动进化）
  ipcMain.handle('evolution-get-config', async () => {
    try { return { success: true, config: evolutionSwitch.getConfig() }; }
    catch (e) { return { success: false, error: e.message }; }
  });
  ipcMain.handle('evolution-set-config', async (_event, patch = {}) => {
    try {
      const enabled = !!(patch && patch.enabled);
      evolutionSwitch.setEnabled(enabled);
      // 运行时切换：立即生效（自驱循环/自动进化的定时器跟随开关启停；curator 定时器常驻，由 tick 自检）
      try {
        const sld = require('./team/self-loop-driver');
        if (enabled) sld.start(); else sld.stop();
      } catch (_) {}
      try {
        const ae = require('./team/auto-evolve');
        if (enabled) ae.startScheduler(); else ae.stopScheduler();
      } catch (_) {}
      return { success: true, config: evolutionSwitch.getConfig() };
    } catch (e) { return { success: false, error: e.message }; }
  });
  // 读引导者配置 + 状态
  ipcMain.handle('curator-get-config', async () => {
    try { return { success: true, status: curator.getStatus() }; }
    catch (err) { return { success: false, error: err.message }; }
  });
  // 更新引导者配置（部分字段）
  ipcMain.handle('curator-set-config', async (_event, patch = {}) => {
    try { return { success: true, config: curator.updateConfig(patch) }; }
    catch (err) { return { success: false, error: err.message }; }
  });
  // 立即触发一次战略巡检（手动）
  ipcMain.handle('curator-trigger-now', async () => {
    try { return await curator.triggerNow(); }
    catch (err) { return { success: false, error: err.message }; }
  });

  // ========== 定时任务（用户可管理的轻量定时注入） ==========
  ipcMain.handle('scheduled-task-list', async () => {
    try {
      const st = require('./scheduled-tasks');
      return { success: true, tasks: st.listTasks() };
    } catch (err) { return { success: false, error: err.message, tasks: [] }; }
  });
  ipcMain.handle('scheduled-task-create', async (_event, opts = {}) => {
    try {
      const st = require('./scheduled-tasks');
      const task = st.createTask(opts || {});
      return { success: true, task: task };
    } catch (err) { return { success: false, error: err.message }; }
  });
  ipcMain.handle('scheduled-task-remove', async (_event, payload = {}) => {
    try {
      const st = require('./scheduled-tasks');
      const id = (payload && payload.id) || '';
      const ok = st.removeTask(id);
      return { success: ok, tasks: st.listTasks() };
    } catch (err) { return { success: false, error: err.message }; }
  });
  ipcMain.handle('scheduled-task-toggle', async (_event, payload = {}) => {
    try {
      const st = require('./scheduled-tasks');
      const id = (payload && payload.id) || '';
      const ok = st.toggleTask(id, !!(payload && payload.enabled));
      return { success: ok, tasks: st.listTasks() };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // ========== 自驱循环目标进度（覆盖层 Goal 面板） ==========
  // 返回当前窗口所属项目（或显式传入 projectDir 的壳层调用）的 goal 列表，
  // 含运行中 + 历史目标（listGoals 已按 createdAt 倒序）。只读，不改任何业务逻辑。
  ipcMain.handle('goal-status-list', async (event, payload) => {
    try {
      const dir = resolveProjectDir(event, payload);
      const selfLoop = require('./team/self-loop');
      const goals = selfLoop.listGoals(dir ? { projectDir: dir } : undefined);
      return { success: true, goals, projectDir: dir || null };
    } catch (err) {
      return { success: false, error: err.message, goals: [] };
    }
  });

  // ========== 账号池 / 代理 / 指纹（窗口管理升级） ==========
  // 读取某窗口的账号+代理+指纹配置
  ipcMain.handle('get-profile-config', async (_event, { profileId } = {}) => {
    try {
      const p = profileManager.getProfileById(profileId);
      if (!p) return { success: false, error: '窗口不存在' };
      return {
        success: true,
        account: p.account || {},
        proxy: p.proxy || {},
        fingerprint: p.fingerprint || {},
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 更新账号元数据
  ipcMain.handle('set-profile-account', async (_event, { profileId, account } = {}) => {
    try {
      const p = profileManager.updateProfileAccount(profileId, account || {});
      if (!p) return { success: false, error: '更新失败' };
      return { success: true, account: p.account };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 更新代理配置（保存后立即应用到该窗口 session）
  ipcMain.handle('set-profile-proxy', async (_event, { profileId, proxy } = {}) => {
    try {
      const p = profileManager.updateProfileProxy(profileId, proxy || {});
      if (!p) return { success: false, error: '更新失败' };
      // 若窗口已打开，立即应用
      const ctx = windowState.getWindowByProfileId(profileId);
      if (ctx && ctx.win && !ctx.win.isDestroyed()) {
        const proxyMgr = require('./proxy');
        await proxyMgr.applyProxy(ctx.win.webContents.session, p.proxy);
      }
      return { success: true, proxy: p.proxy };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 测试代理连通性（不保存，仅测试）
  ipcMain.handle('test-profile-proxy', async (_event, { profileId, proxy } = {}) => {
    try {
      const proxyMgr = require('./proxy');
      const p = profileManager.getProfileById(profileId);
      if (!p) return { success: false, error: '窗口不存在' };
      const ctx = windowState.getWindowByProfileId(profileId);
      if (!ctx || !ctx.win || ctx.win.isDestroyed()) {
        return { success: false, error: '窗口未打开，无法测试（请先打开窗口）' };
      }
      const testProxy = proxy || p.proxy || {};
      const res = await proxyMgr.testProxy(ctx.win.webContents.session, testProxy);
      // 测试后恢复为已保存的正式配置
      await proxyMgr.applyProxy(ctx.win.webContents.session, p.proxy || {});
      return res;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 更新指纹配置（需重启窗口生效）
  ipcMain.handle('set-profile-fingerprint', async (_event, { profileId, fingerprint } = {}) => {
    try {
      const p = profileManager.updateProfileFingerprint(profileId, fingerprint || {});
      if (!p) return { success: false, error: '更新失败' };
      return { success: true, fingerprint: p.fingerprint, needRestart: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 事件日志（拦截/催促/派发/完成 统计） ==========
  const eventLog = require('./event-log');

  // 最近 N 条事件
  ipcMain.handle('event-log-recent', async (_event, { limit } = {}) => {
    try {
      const events = eventLog.getRecentEvents(typeof limit === 'number' ? limit : 50);
      return { success: true, events };
    } catch (err) {
      return { success: false, error: err.message, events: [] };
    }
  });

  // 运行统计（各窗口每日 + 汇总）
  ipcMain.handle('event-log-stats', async () => {
    try {
      const daily = eventLog.getAllDailyStats();
      const summary = eventLog.getSummary();
      return { success: true, daily, summary };
    } catch (err) {
      return { success: false, error: err.message, daily: {}, summary: {} };
    }
  });

  // ========== 知识库 / 技能库 ==========
  const knowledge = require('./knowledge');

  // 取当前窗口项目目录（从 ctx 里取）
  function getCtxProjectDir(event) {
    const ctx = windowState.getContextByWebContents(event.sender);
    return ctx && ctx.sessionStore ? ctx.sessionStore.state.selectedProjectDir : null;
  }

  // 壳层调用时 sender 是壳窗口，拿不到 webview ctx；改由调用方显式传 projectDir。
  function resolveProjectDir(event, payload) {
    if (payload && typeof payload.projectDir === 'string' && payload.projectDir) return payload.projectDir;
    return getCtxProjectDir(event);
  }

  // 列出全部技能（含当前项目启用状态 + 全局启用状态）
  ipcMain.handle('knowledge-list', async (event, payload) => {
    try {
      const projectDir = resolveProjectDir(event, payload);
      const skills = knowledge.listSkills();
      const enabled = projectDir ? knowledge.getEnabledSkills(projectDir) : [];
      const globalEnabled = knowledge.getGlobalEnabledSkills();
      return { success: true, skills, enabled, globalEnabled, projectDir: projectDir || null };
    } catch (err) {
      return { success: false, error: err.message, skills: [], enabled: [], globalEnabled: [] };
    }
  });

  // 读取某技能正文
  ipcMain.handle('knowledge-read', async (_event, { name } = {}) => {
    try {
      if (!name) return { success: false, error: '缺少技能名' };
      const content = knowledge.readSkill(name);
      if (content === null) return { success: false, error: '技能不存在: ' + name };
      return { success: true, name, content };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 保存技能正文（也可改描述）
  ipcMain.handle('knowledge-save', async (_event, { name, content, meta } = {}) => {
    try {
      if (!name) return { success: false, error: '缺少技能名' };
      const r = knowledge.updateSkill(name, typeof content === 'string' ? content : undefined, meta);
      return r && r.success ? { success: true } : { success: false, error: (r && r.error) || '保存失败' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 新建技能
  ipcMain.handle('knowledge-create', async (_event, { name, content, meta } = {}) => {
    try {
      if (!name) return { success: false, error: '缺少技能名' };
      const r = knowledge.createSkill(name, content || '', meta || {});
      return r && r.success ? { success: true, name } : { success: false, error: (r && r.error) || '创建失败' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 删除技能
  ipcMain.handle('knowledge-delete', async (_event, { name } = {}) => {
    try {
      if (!name) return { success: false, error: '缺少技能名' };
      const r = knowledge.deleteSkill(name);
      return r && r.success ? { success: true } : { success: false, error: (r && r.error) || '删除失败' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 列出某技能的历史版本快照（时间 + 摘要 + 是否当前激活）
  ipcMain.handle('knowledge-version-list', async (_event, { name } = {}) => {
    try {
      if (!name) return { success: false, error: '缺少技能名', versions: [] };
      const versions = knowledge.listSkillVersions(name);
      return { success: true, name, versions };
    } catch (err) {
      return { success: false, error: err.message, versions: [] };
    }
  });

  // 回退到指定版本快照
  ipcMain.handle('knowledge-version-restore', async (_event, { name, version } = {}) => {
    try {
      if (!name) return { success: false, error: '缺少技能名' };
      if (!version) return { success: false, error: '缺少版本号' };
      const r = knowledge.restoreSkillVersion(name, version);
      return r && r.success ? { success: true, version: r.version } : { success: false, error: (r && r.error) || '回退失败' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 项目启用技能
  ipcMain.handle('knowledge-enable', async (event, { name, projectDir } = {}) => {
    try {
      if (!name) return { success: false, error: '缺少技能名' };
      const dir = resolveProjectDir(event, { projectDir });
      if (!dir) return { success: false, error: '当前窗口未选择项目目录' };
      const r = knowledge.enableSkill(dir, name);
      return r && r.success ? { success: true } : { success: false, error: (r && r.error) || '启用失败' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 项目禁用技能
  ipcMain.handle('knowledge-disable', async (event, { name, projectDir } = {}) => {
    try {
      if (!name) return { success: false, error: '缺少技能名' };
      const dir = resolveProjectDir(event, { projectDir });
      if (!dir) return { success: false, error: '当前窗口未选择项目目录' };
      const r = knowledge.disableSkill(dir, name);
      return r && r.success ? { success: true } : { success: false, error: (r && r.error) || '禁用失败' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 全局启用技能（跨项目，所有窗口共用）
  ipcMain.handle('knowledge-enable-global', async (_event, { name } = {}) => {
    try {
      if (!name) return { success: false, error: '缺少技能名' };
      const r = knowledge.enableSkillGlobal(name);
      return r && r.success ? { success: true } : { success: false, error: (r && r.error) || '全局启用失败' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 全局禁用技能
  ipcMain.handle('knowledge-disable-global', async (_event, { name } = {}) => {
    try {
      if (!name) return { success: false, error: '缺少技能名' };
      const r = knowledge.disableSkillGlobal(name);
      return r && r.success ? { success: true } : { success: false, error: (r && r.error) || '全局禁用失败' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 读取当前项目已启用技能（含全局启用）
  ipcMain.handle('knowledge-get-enabled', async (event, payload) => {
    try {
      const projectDir = resolveProjectDir(event, payload);
      const enabled = projectDir ? knowledge.getEnabledSkills(projectDir) : [];
      const globalEnabled = knowledge.getGlobalEnabledSkills();
      return { success: true, enabled, globalEnabled, projectDir: projectDir || null };
    } catch (err) {
      return { success: false, error: err.message, enabled: [], globalEnabled: [] };
    }
  });

  // 读取全局偏好
  ipcMain.handle('preference-read', async () => {
    try {
      const content = knowledge.readPreferences();
      return { success: true, content };
    } catch (err) {
      return { success: false, error: err.message, content: '' };
    }
  });

  // 保存全局偏好
  ipcMain.handle('preference-save', async (_event, { content } = {}) => {
    try {
      const ok = knowledge.writePreferences(typeof content === 'string' ? content : '');
      return ok ? { success: true } : { success: false, error: '保存失败' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 账号池（本地加密账号管理 + 窗口绑定 + 失败选号） ==========
  const accountPool = require('./account-pool');

  // 列出账号（可按 providerId 过滤；不含密码，仅含 hasPassword）
  // 账号占用查询：返回 { [accountId]: [{profileId, profileName}] }
  // ========== 磁盘清理 ==========
  // 查询磁盘占用
  ipcMain.handle('cleanup-usage', async () => {
    try { return { success: true, usage: require('./cleanup').getDiskUsage() }; }
    catch (err) { return { success: false, error: err.message }; }
  });
  // 清理缓存（保留登录态）
  ipcMain.handle('cleanup-cache', async () => {
    try { return { success: true, result: require('./cleanup').cleanCacheOnly() }; }
    catch (err) { return { success: false, error: err.message }; }
  });
  // 全量清理（孤儿 partition + 旧截图 + 孤立映射 + 日志）
  ipcMain.handle('cleanup-all', async () => {
    try { return { success: true, result: require('./cleanup').runStartupCleanup() }; }
    catch (err) { return { success: false, error: err.message }; }
  });

  // 读取本地文件为 base64（供 preload 把文件作为附件上传到网页版 AI）
  ipcMain.handle('read-file-base64', async (_event, { path: filePath } = {}) => {
    try {
      if (!filePath) return { success: false, error: '缺少 path' };
      const fsMod = require('fs');
      const pathMod = require('path');
      const abs = pathMod.isAbsolute(filePath) ? filePath : pathMod.resolve(filePath);
      if (!fsMod.existsSync(abs)) return { success: false, error: '文件不存在: ' + abs };
      const buf = fsMod.readFileSync(abs);
      return {
        success: true,
        name: pathMod.basename(abs),
        ext: pathMod.extname(abs).slice(1).toLowerCase(),
        size: buf.length,
        base64: buf.toString('base64'),
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 壳层「上传附件」：弹文件选择框，返回选中文件绝对路径数组
  ipcMain.handle('shell:select-file', async () => {
    try {
      const paths = dialog.showOpenDialogSync({
        title: '选择要上传的附件',
        properties: ['openFile', 'multiSelections'],
      });
      if (!paths || !paths.length) return { success: false, canceled: true, paths: [] };
      return { success: true, paths };
    } catch (err) {
      return { success: false, error: err.message, paths: [] };
    }
  });

  // 壳层「粘贴上传」：把渲染层传来的 base64 内容写入系统临时目录，返回绝对路径
  ipcMain.handle('shell:save-temp-file', async (_event, { base64, name } = {}) => {
    try {
      if (!base64 || typeof base64 !== 'string') return { success: false, error: '内容为空' };
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const dir = path.join(os.tmpdir(), 'tokfree-paste');
      fs.mkdirSync(dir, { recursive: true });
      // 保留原扩展名，文件名加时间戳+随机数避免冲突
      let ext = '';
      try { ext = path.extname(String(name || '')).slice(0, 16); } catch (_) { ext = ''; }
      const fname = 'paste-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + ext;
      const filePath = path.join(dir, fname);
      fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
      return { success: true, path: filePath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 壳层「保存图片」：把 AI 消息里的图片另存到本地。
  // 入参 { dataUrl?, url?, defaultName? }：优先 dataUrl（解码 base64 直接写）；
  // 否则用 url 下载后写（主进程 fetch 无 CORS 限制，可下跨域 http 图片）。
  ipcMain.handle('shell:save-image', async (event, { dataUrl, url, defaultName } = {}) => {
    try {
      const fs = require('fs');
      const safeName = String(defaultName || ('tokfree-image-' + Date.now() + '.png')).replace(/[\\/:*?"<>|]+/g, '_');
      let parent = null;
      try { const { BrowserWindow } = require('electron'); parent = BrowserWindow.fromWebContents(event.sender); } catch (_) { parent = null; }
      const dlgOpts = { title: '保存图片', defaultPath: safeName };
      const saveRes = parent ? await dialog.showSaveDialog(parent, dlgOpts) : await dialog.showSaveDialog(dlgOpts);
      if (!saveRes || saveRes.canceled || !saveRes.filePath) return { success: false, canceled: true };
      const outPath = saveRes.filePath;

      if (dataUrl && typeof dataUrl === 'string') {
        const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
        if (!m) return { success: false, error: '无法识别的图片数据' };
        const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
        fs.writeFileSync(outPath, buf);
        return { success: true, path: outPath };
      }

      if (url && typeof url === 'string' && /^https?:/i.test(url)) {
        const res = await fetch(url);
        if (!res || !res.ok) return { success: false, error: '下载失败：HTTP ' + (res && res.status) };
        const ab = await res.arrayBuffer();
        fs.writeFileSync(outPath, Buffer.from(ab));
        return { success: true, path: outPath };
      }

      return { success: false, error: '缺少图片数据' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('account-usage-list', async () => {
    try {
      const usage = require('./profile-manager').getAccountUsage();
      return { success: true, usage };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('account-pool-list', async (_event, { providerId } = {}) => {
    try {
      const accounts = accountPool.listAccounts(providerId || undefined);
      return { success: true, accounts };
    } catch (err) {
      return { success: false, error: err.message, accounts: [] };
    }
  });

  // 新建账号
  ipcMain.handle('account-pool-create', async (_event, { account } = {}) => {
    try {
      const r = accountPool.createAccount(account || {});
      return r && r.success
        ? { success: true, id: r.id, warning: r.warning || null }
        : { success: false, error: (r && r.error) || '创建失败' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 更新账号（patch.password 若传则重新加密）
  ipcMain.handle('account-pool-update', async (_event, { id, patch } = {}) => {
    try {
      if (!id) return { success: false, error: '缺少账号 id' };
      const r = accountPool.updateAccount(id, patch || {});
      return r && r.success
        ? { success: true, warning: r.warning || null }
        : { success: false, error: (r && r.error) || '更新失败' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 删除账号
  ipcMain.handle('account-pool-delete', async (_event, { id } = {}) => {
    try {
      if (!id) return { success: false, error: '缺少账号 id' };
      const r = accountPool.deleteAccount(id);
      return r && r.success ? { success: true } : { success: false, error: (r && r.error) || '删除失败' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 绑定窗口到账号池账号（写入 profile.account.accountId，保留原账号元数据）
  ipcMain.handle('profile-bind-account', async (_event, { profileId, accountId } = {}) => {
    try {
      if (!profileId) return { success: false, error: '缺少 profileId' };
      const p = profileManager.updateProfile(profileId, { account: { accountId: accountId || '' } });
      if (!p) return { success: false, error: '绑定失败：窗口不存在' };
      // 绑定后立即触发一次登录检查（若窗口正停在登录页，会马上尝试自动登录）
      if (accountId) {
        try {
          const loginManager = require('./login-manager');
          loginManager.scheduleCheck(profileId, 1000);
        } catch (_) {}
      }
      return { success: true, account: p.account };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 手动触发某窗口的登录检查（用于绑定后立即重登 / 手动重试）
  ipcMain.handle('trigger-relogin', async (_event, { profileId } = {}) => {
    try {
      if (!profileId) return { success: false, error: '缺少 profileId' };
      const loginManager = require('./login-manager');
      const res = await loginManager.checkAndRelogin(profileId);
      return { success: true, result: res };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 自动登录失败后，用户选择其他账号 → 转发登录管理器重试
  ipcMain.handle('account-relogin-select', async (_event, { profileId, accountId } = {}) => {
    try {
      const loginManager = require('./login-manager');
      if (loginManager && typeof loginManager.retryWithAccount === 'function') {
        return await loginManager.retryWithAccount(profileId, accountId);
      }
      return { success: false, error: '登录管理器不可用' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 一键登录：用 event.sender 反查窗口 profileId，再用指定账号在该窗口自动登录
  ipcMain.handle('account-quick-login', async (event, { accountId, profileId } = {}) => {
    try {
      if (!accountId) return { success: false, error: '缺少 accountId' };
      // 优先用 renderer 传来的 profileId（overlay 自己知道所在窗口），
      // 其次才用 event.sender 反查 —— 壳层转发/首次加载等边界下反查可能失败。
      let ctx = profileId ? windowState.getWindowByProfileId(profileId) : null;
      if (!ctx) ctx = windowState.getContextByWebContents(event.sender);
      if (!ctx || !ctx.profileId) return { success: false, error: '找不到当前窗口上下文' };
      const loginManager = require('./login-manager');
      if (!loginManager || typeof loginManager.retryWithAccount !== 'function') {
        return { success: false, error: '登录管理器不可用' };
      }
      const res = await loginManager.retryWithAccount(ctx.profileId, accountId);
      return res && typeof res === 'object' ? res : { success: false, error: '登录失败' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 渲染进程获取当前窗口自身的 profileId（用于账号选择框区分「自己占用」与「他人占用」）
  ipcMain.handle('get-current-profile-id', async (event) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      return { success: !!ctx, profileId: ctx ? ctx.profileId : '' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 任务清单（todo_write）读取：覆盖层「任务清单」面板
  ipcMain.handle('todo-list', async (event) => {
    try {
      const ctx = windowState.getContextByWebContents(event.sender);
      const todoStore = require('./todo-store');
      const data = todoStore.getTodos(ctx ? ctx.profileId : null);
      return { success: true, todos: data.list, updatedAt: data.updatedAt };
    } catch (err) {
      return { success: false, error: err.message, todos: [] };
    }
  });

  // 任务清单（壳层级读取）：壳窗口 sender 非 webview，需显式传 profileId
  ipcMain.handle('shell:todo-list', async (_event, { profileId } = {}) => {
    try {
      const todoStore = require('./todo-store');
      const data = todoStore.getTodos(profileId || null);
      return { success: true, todos: data.list, updatedAt: data.updatedAt };
    } catch (err) {
      return { success: false, error: err.message, todos: [] };
    }
  });

  // 编排计划（plan，多 Agent 模式）：壳层读取主大脑的计划进度，供进程胶囊显示。
  // 壳窗口 sender 非 webview，需显式传 profileId（主大脑的 profileId）。
  ipcMain.handle('shell:plan-get', async (_event, { profileId } = {}) => {
    try {
      const plan = require('./team/plan').getPlan(profileId || null);
      return { success: true, plan };
    } catch (err) {
      return { success: false, error: err.message, plan: null };
    }
  });

  // ========== 会话搜索 / 导出 ==========
  // 搜索会话：按 sessionId / 别名 / 项目目录模糊匹配（消息内容不在 session-store 中）
  ipcMain.handle('session-search', async (event, { query, projectDir = null, profileId = null } = {}) => {
    try {
      let ctx = null;
      if (profileId) ctx = windowState.getWindowByProfileId(profileId);
      if (!ctx) ctx = windowState.getContextByWebContents(event.sender);
      const store = ctx ? ctx.sessionStore : null;
      if (!store || typeof store.searchSessions !== 'function') {
        return { success: false, error: '会话存储不可用', results: [] };
      }
      let results = store.searchSessions(query);
      if (projectDir) results = results.filter(r => r.projectDir === projectDir);
      return { success: true, results };
    } catch (err) {
      return { success: false, error: err.message, results: [] };
    }
  });

  // 导出会话：消息由渲染层从 webview 采集后传入；主进程只负责序列化 + 写文件
  ipcMain.handle('session-export', async (event, { sessionId, messages, format, outPath } = {}) => {
    try {
      if (!sessionId) return { success: false, error: '缺少会话ID' };
      const ctx = windowState.getContextByWebContents(event.sender);
      const store = ctx ? ctx.sessionStore : null;
      const aliases = (store && typeof store.getAliases === 'function') ? store.getAliases() : {};
      const { exportSession } = require('./session-export');
      return exportSession(sessionId, messages, format, outPath, aliases);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 文件检查点 / 回滚 ==========
  // 列出最近的文件快照（edit/write/delete 前自动保存的旧内容）
  ipcMain.handle('checkpoint-list', async (_event, { limit } = {}) => {
    try {
      const { getCheckpointStore } = require('./checkpoint');
      const store = getCheckpointStore();
      const n = Number.isInteger(limit) ? limit : 50;
      const checkpoints = store.list().slice(0, n).map((r) => ({
        id: r.id,
        filePath: r.filePath,
        operation: r.operation,
        deleted: !!r.deleted,
        createdAt: r.createdAt,
        size: r.size
      }));
      return { success: true, checkpoints };
    } catch (err) {
      return { success: false, error: err.message, checkpoints: [] };
    }
  });

  // 回滚到某个快照
  ipcMain.handle('checkpoint-restore', async (_event, { id } = {}) => {
    try {
      if (!id) return { success: false, error: '缺少快照 id' };
      const { getCheckpointStore } = require('./checkpoint');
      const store = getCheckpointStore();
      const res = store.restore(id);
      return res.success ? { success: true, filePath: res.filePath } : { success: false, error: res.error };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== Git 集成 ==========
  // 查询 git 状态：分支 + 变更文件列表（modified/added/deleted 等）。
  // 通过 resolveProjectDir 兼容壳层调用（显式传 projectDir）与窗口调用（从 ctx 取）。
  ipcMain.handle('git-status', async (event, payload) => {
    try {
      const dir = resolveProjectDir(event, payload);
      if (!dir) return { success: false, isRepo: false, error: '当前窗口未选择项目目录' };
      const { getStatus, getLog } = require('./git');
      const status = await getStatus(dir);
      if (!status.isRepo) {
        return { success: true, isRepo: false, branch: null, files: [], commits: [], projectDir: dir };
      }
      const log = await getLog(dir, 20);
      return {
        success: true,
        isRepo: true,
        branch: status.branch,
        files: status.files,
        commits: log.commits,
        projectDir: dir
      };
    } catch (err) {
      return { success: false, isRepo: false, error: err.message };
    }
  });

  // 查看某文件 diff
  ipcMain.handle('git-diff', async (event, { file, projectDir } = {}) => {
    try {
      const dir = resolveProjectDir(event, { projectDir });
      if (!dir) return { success: false, error: '当前窗口未选择项目目录' };
      if (!file) return { success: false, error: '缺少文件路径' };
      const { getDiff } = require('./git');
      const r = await getDiff(dir, file);
      if (r.error) return { success: false, error: r.error };
      return { success: true, file, diff: r.diff };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== @ 引用文件（上下文选择器） ==========
  // 扫描当前项目文件，供输入框 @ 补全。限制数量 + 排除 node_modules/.git 等。
  // 壳窗口 sender 非 webview，projectDir 由调用方显式传入（见 shell-preload.js）。
  ipcMain.handle('list-project-files', async (event, payload = {}) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const projectDir = resolveProjectDir(event, payload);
      if (!projectDir) return { success: false, error: '当前窗口未选择项目目录', files: [] };
      let stat;
      try { stat = fs.statSync(projectDir); } catch (_) { return { success: false, error: '项目目录不存在', files: [] }; }
      if (!stat.isDirectory()) return { success: false, error: '项目目录无效', files: [] };

      const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.cache', '.next', '.nuxt', 'coverage', 'vendor', '__pycache__']);
      const MAX_FILES = 2000;
      const MAX_DEPTH = 8;
      const files = [];

      function walk(dir, rel, depth) {
        if (files.length >= MAX_FILES || depth > MAX_DEPTH) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const ent of entries) {
          if (files.length >= MAX_FILES) return;
          const name = ent.name;
          if (ent.isDirectory()) {
            if (EXCLUDE_DIRS.has(name)) continue;
            if (name.charAt(0) === '.' && name !== '.tokfreeCode') continue;
            walk(path.join(dir, name), rel ? rel + '/' + name : name, depth + 1);
          } else if (ent.isFile()) {
            files.push(rel ? rel + '/' + name : name);
          }
        }
      }
      walk(projectDir, '', 0);
      files.sort((a, b) => a.localeCompare(b));
      return { success: true, files, truncated: files.length >= MAX_FILES, projectDir };
    } catch (err) {
      return { success: false, error: err.message, files: [] };
    }
  });

  // ========== API 型 Provider 传输通道（新增，不改现有逻辑）==========
  // 渲染进程本地聊天页经此向 OpenAI 兼容后端发起请求，规避 CORS。
  // 契约：opts = { baseUrl, path, authKey, method?, body?, stream? }；
  // 返回 apiRequest 的返回值（{ok,status,data} 或 {ok,status,streamText}）。
  ipcMain.handle('api-provider-request', async (event, opts) => {
    try {
      const { apiRequest } = require('./api-provider');
      return await apiRequest(opts || {});
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  // ========== 本地 OpenAI 兼容 API 服务（api-server.js）控制 ==========
  ipcMain.handle('api-server-get', async () => {
    try {
      return { success: true, status: apiServer.getStatus(), config: apiServer.readConfig() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('api-server-set', async (_event, patch = {}) => {
    try {
      const before = apiServer.readConfig();
      apiServer.writeConfig(patch || {});
      const after = apiServer.readConfig();
      // enabled 变更 → 起停服务；端口变更且正在运行 → 重启以生效
      if (before.enabled !== after.enabled) {
        if (after.enabled) apiServer.start();
        else apiServer.stop();
      } else if (after.enabled && before.port !== after.port && apiServer.getStatus().running) {
        apiServer.stop();
        apiServer.start();
      }
      return { success: true, status: apiServer.getStatus(), config: apiServer.readConfig() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== ShardX 反检测浏览器：只读状态查询（供设置面板展示）==========
  ipcMain.handle('shardx-status', async () => {
    try {
      const shardxManager = require('./shardx-manager');
      return { success: true, status: shardxManager.getStatus() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== API 型 Provider 配置（按 profile 持久化，供壳层配置条读写）==========
  const API_CONFIG_DEFAULT = { baseUrl: 'http://localhost:3000/v1', authKey: '', model: 'auto', image: false };
  ipcMain.handle('api-config-get', async (_event, { profileId } = {}) => {
    try {
      if (!profileId) return { success: false, error: '缺少 profileId' };
      const p = profileManager.getProfileById(profileId);
      const cfg = (p && p.apiConfig) ? Object.assign({}, API_CONFIG_DEFAULT, p.apiConfig) : API_CONFIG_DEFAULT;
      return { success: true, config: cfg };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('api-config-set', async (_event, { profileId, config } = {}) => {
    try {
      if (!profileId) return { success: false, error: '缺少 profileId' };
      const p = profileManager.updateProfile(profileId, { apiConfig: config || {} });
      if (!p) return { success: false, error: '窗口不存在' };
      return { success: true, config: p.apiConfig };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 更新日志（多版本标签页弹窗） ==========
  ipcMain.handle('get-changelog', async () => {
    try {
      const changelog = require('./changelog');
      return changelog.getChangelog();
    } catch (err) {
      return { success: false, error: err.message, versions: [] };
    }
  });
  ipcMain.handle('open-changelog', async () => {
    try {
      const changelog = require('./changelog');
      return changelog.openChangelogWindow();
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerIpcHandlers };

