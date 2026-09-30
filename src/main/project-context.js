/**
 * 项目初始化：目录选择、系统提示词组合与发送
 * 由原 main.js 拆分而来，逻辑保持不变。
 */
const { app, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const windowState = require('./window');
const { toolRegistry } = require('./tool-registry');
const mcpClient = require('./mcp-client');
const { logger } = require('../core/logger');

// 提示词模板目录
const PROMPT_DIR = path.join(__dirname, '..', 'prompt');

/**
 * 同时输出到终端和对应平台的日志文件（与渲染进程日志同目录）
 */
function logWithFile(providerId, msg) {
  logger.info(msg);
  try {
    if (!app.isPackaged) {
      const logDir = path.join(app.getPath('userData'), 'wyp', 'log');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, (providerId || 'default') + '.log');
      fs.appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + msg + '\n', 'utf-8');
    }
  } catch (_) {}
}

/**
 * 初始化项目：选择目录并发送 systemPrompt
 * 供 IPC 调用（用户点击初始化按钮时触发）
 * @param {boolean} skipPrompt - 如果为true，只更新目录映射，不发送初始提示（用于修改目录）
 */
async function initProject(skipPrompt = false, windowContext = null, forcedDir = null, taskSuffix = null, isCompaction = false) {
  const ctx = windowContext || windowState.getMainContext();
  const mainWindow = ctx ? ctx.win : windowState.getMainWindow();
  const sessionStore = ctx ? ctx.sessionStore : null;
  // providerId 来自窗口上下文（可能为空，表示未确定平台）
  const providerId = (ctx && ctx.providerId) || '';

  // 目录来源：优先使用调用方传入的 forcedDir（次大脑自动初始化），否则弹框让用户选择
  let selectedDir;
  if (forcedDir) {
    selectedDir = forcedDir;
    logger.info('[TokFree] 使用指定目录（免弹框）:', selectedDir);
  } else {
    // 解析 dialog 的 parent window（必须是真实 BrowserWindow）。
    // 多标签架构下 ctx.win 是 webview 适配器（不是 BrowserWindow），
    // 直接传给 dialog 会让 Electron 忽略 properties，导致"文件夹选择框"被弹成"文件选择框"。
    // 策略：能拿到真实 BrowserWindow 就作为 parent；否则退化为无 parent 调用（properties 仍生效）。
    let parentWin = null;
    try {
      const { BrowserWindow } = require('electron');
      const cand = mainWindow;
      if (cand instanceof BrowserWindow && !cand.isDestroyed()) {
        parentWin = cand;
      } else if (cand && cand.webContents) {
        // webview 适配器：尝试反查其真实宿主窗口
        try {
          const real = BrowserWindow.fromWebContents(cand.webContents);
          if (real && !real.isDestroyed()) parentWin = real;
        } catch (_) {}
      }
      // 兜底：直接向 windowState 要"主窗口"（壳窗口注册后即为真实 BrowserWindow）
      if (!parentWin) {
        try {
          const mw = windowState.getMainWindow();
          if (mw instanceof BrowserWindow && !mw.isDestroyed()) parentWin = mw;
        } catch (_) {}
      }
    } catch (_) {}

    // 关键：properties: ['openDirectory'] 才能弹目录选择框。
    // 有合法 parent 时带 parent；无则退化为单参数调用（无父窗口，properties 依然生效）。
    const dialogOpts = {
      properties: ['openDirectory'],
      buttonLabel: '选择目录',
      title: '请选择要分析的项目目录',
    };
    const result = parentWin
      ? dialog.showOpenDialogSync(parentWin, dialogOpts)
      : dialog.showOpenDialogSync(dialogOpts);

    // 无论用户是否选择目录，对话框关闭后都恢复主窗口焦点（避免输入框失效）
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.focus(); } catch (_) {}
      try { if (mainWindow.webContents) mainWindow.webContents.focus(); } catch (_) {}
    }

    if (!result || result.length === 0) {
      logger.info('[TokFree] 用户取消了目录选择');
      return { success: false, message: '用户取消了目录选择' };
    }
    selectedDir = result[0];
  }
  logger.info('[TokFree] 用户选择目录:', selectedDir);
  const tStart = Date.now();
  const stepLog = (msg) => logWithFile(providerId, '[TokFree][耗时] ' + msg + ' +' + (Date.now() - tStart) + 'ms');

  // 保存选中的项目目录（若该窗口有独立的 sessionStore）
  if (sessionStore) {
    sessionStore.state.selectedProjectDir = selectedDir;

    // ========== 持久化存储会话-目录映射 ==========
    // 如果当前有会话ID，保存映射
    if (sessionStore.state.currentSessionId) {
      sessionStore.saveSessionDirMapping(sessionStore.state.currentSessionId, selectedDir);
      logger.info(`[TokFree] 已保存会话 ${sessionStore.state.currentSessionId} -> ${selectedDir}`);
    } else {
      // 如果未能获取会话ID，尝试从当前URL提取
      let sessionId = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        const url = mainWindow.webContents.getURL();
        sessionId = sessionStore.extractSessionIdFromUrl(url);
      }
      if (sessionId) {
        sessionStore.state.currentSessionId = sessionId;
        sessionStore.saveSessionDirMapping(sessionId, selectedDir);
        logger.info(`[TokFree] 从URL提取会话ID并保存: ${sessionId} -> ${selectedDir}`);
      } else {
        // 无法获取会话ID，暂存项目目录，等待URL变化后绑定
        sessionStore.state.pendingProjectDir = selectedDir;
        logger.info(`[TokFree] 暂存项目目录 ${selectedDir}，等待会话ID出现后绑定`);
      }
    }
  }

  stepLog('目录保存完成');
  // 发送目录更新事件到渲染进程
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('project-dir-updated', selectedDir);
  }

  // 如果只是修改目录，跳过发送初始提示
  if (skipPrompt) {
    return { success: true, message: '项目目录已更新' };
  }

  // 初始化项目时读取对应平台模板并替换占位符
  // 模板选择优先级：
  // 1. provider.getPromptTemplate() 返回的非空字符串
  // 2. src/prompt/{providerId}.md
  // 3. src/prompt/default.md
  const provider = require('../providers').getProvider(providerId);
  let templateContent = '';
  let templatePath = '';

  if (provider && typeof provider.getPromptTemplate === 'function') {
    try {
      const fromMethod = provider.getPromptTemplate();
      if (fromMethod && typeof fromMethod === 'string' && fromMethod.trim()) {
        templateContent = fromMethod;
        templatePath = '(provider.getPromptTemplate)';
      }
    } catch (err) {
      logger.warn('[TokFree] 调用 provider.getPromptTemplate 失败:', err.message);
    }
  }

  if (!templateContent && providerId) {
    const candidate = path.join(PROMPT_DIR, providerId + '.md');
    if (fs.existsSync(candidate)) {
      templatePath = candidate;
    }
  }

  if (!templateContent && templatePath) {
    try {
      templateContent = fs.readFileSync(templatePath, 'utf-8');
    } catch (err) {
      logger.error('[TokFree] 读取提示词模板失败:', err.message);
      return { success: false, message: '读取提示词模板失败: ' + err.message };
    }
  }

  if (!templateContent) {
    templatePath = path.join(PROMPT_DIR, 'default.md');
    try {
      templateContent = fs.readFileSync(templatePath, 'utf-8');
      logger.warn('[TokFree] 未找到平台模板，使用默认模板:', templatePath);
    } catch (err) {
      logger.error('[TokFree] 读取默认模板失败:', err.message);
      return { success: false, message: '读取默认提示词模板失败: ' + err.message };
    }
  }

  logger.info('[TokFree] 已读取提示词模板:', templatePath);

  stepLog('读取模板完成');
  // 读取工具 API 类型定义（从 d.ts 文件读取，避免与模板重复维护）
  let toolApiTypes = '';
  try {
    toolApiTypes = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'tokfree-tools.d.ts'), 'utf-8');
  } catch (err) {
    logger.error('[TokFree] 读取 tokfree-tools.d.ts 失败:', err.message);
  }

  // 获取工具库描述（JS API 格式：AI 通过生成 JS 代码调用这些函数）
  // 按模式分组注入：多 Agent 模式注入全部（含 team_*）；
  // 单聊模式排除 team_* 前缀工具（用不到，白占 token）。
  const teamMode = require('./team/mode');
  const currentMode = teamMode.getMode(ctx ? ctx.profileId : null);
  const toolsDescription = toolRegistry.getFormattedJsApiForPrompt(
    currentMode === 'multi' ? {} : { exclude: ['team_'] }
  );

  // 获取工具使用指导（section 机制，仿 dsh）
  // isWorker：本次是主大脑派发的子任务（有 taskSuffix）→ 不注入"主大脑"提示词，
  // 避免与 Worker 协议（"你是次大脑，执行任务"）矛盾。
  const promptSections = toolRegistry.getFormattedPromptSections({
    profileId: ctx ? ctx.profileId : null,
    isWorker: !!taskSuffix,
  });

  stepLog('工具描述生成完成');
  // 确保已启用的 MCP server 已连接。
  // 改为【后台异步连接】：不阻塞初始化（MCP 慢/挂起时，初始化照常完成，
  // AI 先拿到提示词；MCP 连接就绪后由工具调用按需等待）。
  try {
    mcpClient.connectEnabledServers().catch(function (err) {
      logger.error('[MCP] 后台连接失败:', err && err.message);
    });
  } catch (err) {
    logger.error('[MCP] 初始化时连接失败:', err.message);
  }

  // MemPalace wing 名：与 init 一致，目录名中非字母数字替换为下划线
  const mempalaceWing = path.basename(selectedDir).replace(/[^a-zA-Z0-9]/g, '_') || 'general';

  // MCP 章节：按需查看模式，不在提示词中全量注入工具列表
  const mcpSection = [
    '## MCP 能力',
    '',
    '本应用支持 MCP（Model Context Protocol）外部工具扩展。',
    '',
    '使用 MCP 前，请先查询可用能力：',
    '1. 调用 mcpListServers() 查看当前已配置的 MCP server 列表（含启用/连接状态）',
    '2. 调用 mcpGetTools(serverName) 查看指定 server 提供的工具和参数',
    '3. 确认后通过 mcpCall(server, tool, args) 调用具体工具',
    '',
    '注意：MCP server 可能未连接或未启用，以 mcpListServers() 的实时返回为准。',
    '',
    '## 长期记忆（MemPalace）',
    '',
    '本应用接入了 MemPalace 长期记忆系统（MCP server 名：mempalace）。',
    '它跨会话保存重要信息，弥补 AI 在长周期项目中会遗忘的问题。',
    '',
    '### 何时读取记忆',
    '- 每次项目初始化后（也就是现在这次），先调用一次 mcpCall("mempalace", "mempalace_status", {}) 查看记忆库概览。',
    '- 当用户提到"之前"、"上次"、"我们讨论过"、过去的决策/约定，或你要做与历史相关的判断时，先用 mcpCall("mempalace", "mempalace_search", { query: "关键词" }) 检索，再基于检索结果回答。',
    '- 检索到内容后如实引用，不要凭印象编造。记忆库没有就说没有。',
    '',
    '### 何时写入记忆',
    '- 完成一个重要步骤或里程碑后（如：定位并修复一个 bug、确定一套架构方案、做出会影响后续的决策、用户明确表达的偏好或约定），调用 mcpCall("mempalace", "mempalace_add_drawer", { content: "简明描述：做了什么、为什么、结论/结果", wing: "' + mempalaceWing + '" }) 把关键结论存下来。room 可留空或按内容自定。',
    '- 生成项目说明文档（.tokfreeCode/TOKFREE.md）后，应把项目核心信息（技术栈、核心功能、关键约定）写入上述 wing 的记忆。',
    '- 只存长期有价值的信息（决策、结论、约定、踩过的坑），不要存临时过程、命令输出、大段代码。',
    '',
    '### 注意',
    '- 记忆读写是按需的，不要每轮对话都读写。上下文里已有的信息不必再查。',
    '- 如果 mempalace 未连接（mcpListServers() 里看不到），跳过上述步骤，正常工作即可。',
    '',
    '### MemPalace 常用工具速查',
    '- mempalace_status：查看记忆库概览与统计',
    '- mempalace_search：语义检索记忆（参数 query，可选 wing/room）',
    '- mempalace_add_drawer：新增一条记忆（参数 content，可选 wing/room）',
    '- mempalace_diary_write：写日记式记录（参数 entry）',
    '- mempalace_checkpoint：一次性保存整段会话要点',
    '- 用法：await mcpCall("mempalace", "<工具名>", { ...参数 })',
  ].join('\n');

  // 动态生成平台信息（不硬编码，根据实际运行环境）
  const platform = process.platform;
  const arch = process.arch;
  let platformInfo = '';
  if (platform === 'win32') {
    platformInfo = '- 操作系统：Windows（' + arch + '）\n  - bash 使用 cmd.exe（Windows 命令：cd / dir / echo %cd% / type / findstr）\n  - pwsh 使用 PowerShell（Get-Location / $env:VAR / Get-ChildItem）\n  - 路径分隔符为反斜杠 \\，传给工具的相对路径统一用正斜杠 /';
  } else if (platform === 'darwin') {
    platformInfo = '- 操作系统：macOS（' + arch + '）\n  - bash 使用 zsh/bash（Unix 命令：pwd / ls / cat / grep）\n  - 路径分隔符为正斜杠 /';
  } else {
    platformInfo = '- 操作系统：Linux（' + arch + '）\n  - bash 使用 bash（Unix 命令：pwd / ls / cat / grep）\n  - 路径分隔符为正斜杠 /';
  }

  // 读取项目介绍（TOKFREE.md）
  let projectIntro = '';
  const tokfreeMdPath = path.join(selectedDir, '.tokfreeCode', 'TOKFREE.md');
  if (fs.existsSync(tokfreeMdPath)) {
    try {
      projectIntro = fs.readFileSync(tokfreeMdPath, 'utf-8');
      logger.info('[TokFree] 已读取 TOKFREE.md 内容');
    } catch (err) {
      logger.error('[TokFree] 读取 TOKFREE.md 失败:', err.message);
    }
  }

  // 项目介绍占位符：无内容则整体置空
  const projectIntroSection = projectIntro
    ? '---\n## 项目介绍\n' + projectIntro
    : '';

  // 统一替换模板中的双花括号占位符（全量替换，支持同一占位符多次出现）
  const placeholders = {
    '{{TOOL_API_TYPES}}': toolApiTypes,
    '{{TOOLS_LIST}}': toolsDescription,
    '{{TOOL_SECTIONS}}': promptSections,
    '{{PLATFORM_INFO}}': platformInfo,
    '{{PROJECT_DIR}}': selectedDir,
    '{{PROJECT_INTRO_SECTION}}': projectIntroSection,
    '{{MCP_SECTION}}': mcpSection,
  };
  let combined = templateContent;
  const templateHasMcpSection = combined.includes('{{MCP_SECTION}}');
  for (const [key, value] of Object.entries(placeholders)) {
    combined = combined.split(key).join(value);
  }
  // 模板未引用 {{MCP_SECTION}} 时，自动追加 MCP/记忆章节，确保 AI 始终获得该能力说明
  if (!templateHasMcpSection && mcpSection) {
    combined = combined + '\n\n---\n\n' + mcpSection;
  }

  // 追加"任务流程规范"章节：统一所有任务的工作流，注入所有平台。
  // 目的：AI 收到任何任务都遵循「分析→调研→计划→执行→测试→记忆」六步流程；
  // 其中"计划用 todo_write"驱动覆盖层的任务清单（进程胶囊）显示。
  combined = combined + '\n\n---\n\n' + [
    '## 任务流程规范（所有任务必须遵循）',
    '',
    '收到任何任务（无论大小），都必须按以下流程推进，不要直接跳到写代码：',
    '',
    '1. **分析**：先理解需求并拆解，在回复里简短列出（要做什么、涉及哪些文件/模块、边界情况）。需求模糊先提澄清性问题。',
    '2. **调研**：动手前先查证——用 read / grep / glob 读相关代码与资料，确认现状再改；不确定就查，不要凭印象猜测。',
    '3. **计划（硬性，不可跳过）**：收到任务后**第一件事**就是用 todoWrite 写出步骤清单——**哪怕是最简单的任务，也要拆成至少 2 步**（如"读文件"→"改代码"→"测试"），绝不允许不写 todo 就开始干活。步骤要简短祈使句、可判定完成。',
    '   - 简单任务（单文件小改）：2-4 步。',
    '   - 复杂任务（多文件/多模块）：先规划再拆解，5-10 步，标注先后依赖。',
    '   - **本应用的进程胶囊（右侧任务进度）完全依赖 todoWrite**——不写 todo，用户就看不到进度。',
    '   - **主大脑也必须写 todo**：无论单聊还是多 Agent 模式，本窗口（你）都必须用 todoWrite 维护自己的任务清单。即便你是主大脑（负责规划/派发/验收），也要把"你要做的事"（分析需求、建计划、派发模块、验收、汇总等）写成 todo，否则本窗口的「任务进度」胶囊一直显示"空闲"，用户看不到主任务进度。多 Agent 模式里 team_plan_create 管的是子 Agent 的模块进度，**不能替代**你自己的 todoWrite。',
    '   - **用户中途追加的待办要追加进进度**：任务进行中用户提出新需求/待办时，**立即用 todoWrite 把它追加进当前清单**——保留已有项（含已完成项），把新项加进去，再整体写回，然后逐项推进。进度要完整反映"原有项 + 新加入项"。注意 todoWrite 是全量替换：追加时先取现有清单、加上新项、再整体写回，不要直接覆盖掉原有项。',
    '4. **执行（逐步推进）**：严格按 todo 顺序做。**每开始一步置 in_progress，完成立即置 completed**，下一步置 in_progress——让胶囊实时反映"进行到第几步 + 已用时间"。不要一次全标完成，要逐步更新。',
    '5. **测试**：改完代码必须验证——跑 npm test 或相关检查命令，确认通过后再收尾。未经验证的改动不算完成。',
    '6. **更新项目记忆**：任务结束时用 mcpCall("mempalace", "mempalace_add_drawer", { content: "做了什么/为什么/结果", wing: "<项目>", room: "<主题>" }) 记录本次结论（仅长期有价值的信息）。',
    '',
    '要点：先计划再执行、进度实时可见、改动必测试、结束必记录。**todoWrite 是所有任务的强制起点（含简单任务）；胶囊的可视化依赖它。**',
    '',
    '**多 Agent 模式**（总经理模式）：主大脑必须先用 team_plan_create 建编排计划（含模块拆分 + 验收标准），再逐个派发；每完成一个模块（收到 Worker DONE）立即更新该模块的 plan 状态（bindTaskToReadyModule / markDoneByTaskId 由派发与回报链路自动维护）。进程胶囊会据此显示各模块进度与计时（从 plan 创建起算，全部模块完成才冻结）。',
  ].join('\n');

  // 追加"全局知识库"章节：跨项目共享的用户偏好 + 本项目启用的技能
  try {
    const knowledge = require('./knowledge');
    const kSection = knowledge.buildKnowledgeSection(selectedDir, taskSuffix || '');
    if (kSection) {
      combined = combined + "\n\n---\n\n" + kSection;
      logger.info('[TokFree] 已注入全局知识库章节');
    }
  } catch (err) {
    logger.error('[TokFree] 注入知识库失败:', err.message);
  }

  // 追加"经验教训"章节：从过往失败中学到的教训（Reflexion 式主动注入）
  // lessons.js 可能尚未就绪，必须 try-catch 兼容，未就绪时静默跳过。
  try {
    const lessons = require('./lessons');
    // 关键词：项目目录名 + 任务内容（若有），用于匹配 tags
    const keywords = [];
    try {
      const base = path.basename(selectedDir || '');
      if (base) keywords.push(base);
    } catch (_) {}
    if (taskSuffix) keywords.push(taskSuffix);
    const matched = lessons.matchLessons(selectedDir, keywords, 5);
    if (Array.isArray(matched) && matched.length > 0) {
      const lines = ['## 经验教训（从过往失败中学到，务必避免重蹈）', ''];
      const ids = [];
      for (const l of matched) {
        const tag = (l.tags && l.tags.length) ? l.tags.join(', ') : 'general';
        lines.push('- [' + tag + '] ' + l.lesson + '（学自：' + (l.context || '') + '）');
        if (l.id) ids.push(l.id);
      }
      combined = combined + "\n\n---\n\n" + lines.join('\n');
      logger.info('[TokFree] 已注入经验教训章节，共', matched.length, '条');
      if (ids.length) {
        try { lessons.bumpHits(ids); } catch (e) { logger.error('[TokFree] bumpHits 失败:', e.message); }
      }
    }
  } catch (err) {
    // lessons.js 未就绪或出错：静默跳过，不影响初始化
    if (err && err.code !== 'MODULE_NOT_FOUND') {
      logger.error('[TokFree] 注入经验教训失败:', err.message);
    }
  }

  // 追加"历史观察"章节：注入本 profile 最近的观察日志（Observational Memory）
  // 与压缩（摘要式）互补：观察日志是 AI 主动沉淀的结构化记忆，跨会话注入。
  // observations.js 可能尚未就绪，必须 try-catch 兼容，未就绪时静默跳过。
  try {
    const observations = require('./observations');
    const pid = ctx ? ctx.profileId : null;
    const obsList = observations.listObservations(pid, 10);
    const refList = observations.listReflections(pid);
    if ((obsList && obsList.length) || (refList && refList.length)) {
      const lines = ['## 历史观察', ''];
      if (refList && refList.length) {
        lines.push('### 反思（高层结论）');
        for (const r of refList) lines.push('- ' + r.summary);
        lines.push('');
      }
      if (obsList && obsList.length) {
        lines.push('### 观察（最近 ' + obsList.length + ' 条）');
        for (const o of obsList) {
          const src = o.source ? ('（来源：' + o.source + '）') : '';
          lines.push('- [' + o.category + '] ' + o.summary + src);
        }
      }
      combined = combined + '\n\n---\n\n' + lines.join('\n');
      logger.info('[TokFree] 已注入历史观察章节，共', (obsList ? obsList.length : 0), '条观察，', (refList ? refList.length : 0), '条反思');
    }
  } catch (err) {
    if (err && err.code !== 'MODULE_NOT_FOUND') {
      logger.error('[TokFree] 注入历史观察失败:', err.message);
    }
  }

  // 追加"观察日志"引导章节：告诉 AI 主动产出观察、适时归纳反思
  combined = combined + '\n\n---\n\n' + [
    '## 观察日志（Observational Memory）',
    '',
    '本应用会长期沉淀你在工作中主动产出的「观察」，跨会话注入，避免新会话重复摸索。请在以下时机主动调用 observation_add 记录：',
    '- 做出影响后续的决策（category=决策）',
    '- 得知用户稳定的偏好（category=偏好）',
    '- 踩到坑 / 发现反直觉的坑（category=踩坑）',
    '- 产生待办事项（category=待办）',
    '- 掌握重要的上下文事实（category=上下文）',
    '',
    'category 须为中文合法值之一：决策 / 偏好 / 踩坑 / 待办 / 上下文。',
    '当积累较多观察（约 15 条以上）时，调用 observation_merge(summary) 归纳出高层结论（反思）。',
    '- observation_add(category, summary) — 记录一条观察',
    '- observation_list(limit) — 列出最近的观察',
    '- observation_merge(summary) — 归纳出高层反思',
  ].join('\n');

  // 追加"完成确认暗号"章节：让 AI 知道任务真正完成时需附上暗号，看门狗据此停止催促
  try {
    const watchdog = require('./watchdog');
    // 优先取本窗口当前的随机暗号（每次用户发新消息轮换），回退到配置里的固定值
    let kw = '';
    try { if (watchdog.getDoneKeyword) kw = watchdog.getDoneKeyword(ctx ? ctx.profileId : null) || kw; } catch (_) {}
    if (!kw && watchdog.getConfig) kw = watchdog.getConfig().doneKeyword || '';
    if (kw) {
      combined = combined + '\n\n---\n\n' + [
        '## 任务完成确认（重要）',
        '',
        '每个阶段性任务结束时，如果你判断已经**全部完成、无需再推进**，请在回复的最后单独附上暗号：',
        '',
        '【' + kw + '】',
        '',
        '如果任务尚未完成，请继续推进，不要停在半途，也不要附暗号。',
        '（暗号用于通知本地看门狗停止催促，务必在真正完成时才输出。）',
      ].join('\n');
      logger.info('[TokFree] 已追加完成确认暗号章节');
    }
  } catch (err) {
    logger.error('[TokFree] 追加完成确认章节失败:', err.message);
  }

  // 压缩后续接：引导新会话基于交接摘要主动补全上下文，再继续工作
  if (isCompaction) {
    const NL = String.fromCharCode(10);
    combined = combined + NL + NL + '---' + NL + NL + [
      '## 上下文续接（重要）',
      '',
      '本会话由上一个会话「上下文压缩」后开启，上方分享内容包含上个会话的交接摘要与最近对话。',
      '',
      '在继续工作前，请先补齐对项目的完整认识：',
      '1. 阅读交接摘要，明确已完成的工作、当前状态、待办事项。',
      '2. 主动用工具读取摘要中提到的关键文件、目录或资料（read / glob / grep 等），用真实内容确认理解，不要仅凭摘要臆测。',
      '3. 需要外部信息时，可查资料或检索长期记忆（mempalace_search）。',
      '4. 确认上下文补全后，接着之前的工作继续推进。',
    ].join(NL);
    logger.info('[TokFree] 已追加压缩续接提示');
  }

  // 可选：把任务内容合并进同一条初始提示（次大脑一次性获得系统提示词 + 任务）
  let finalPrompt = combined;
  if (taskSuffix) {
    const NL = String.fromCharCode(10);
    // Worker 协议：明确"你是次大脑"，并教它用三级暗号回传主大脑。
    // 根因：Worker 窗口默认走单聊提示词，不知道要回传，导致任务完成后主大脑收不到汇报。
    const workerProtocol = [
      '# ⚠️ 你是「次大脑」（Worker Agent），不是单聊助手',
      '',
      '你由主大脑（另一个 TokFree 窗口）派发任务。**忽略系统提示词里"单聊模式 / 你直接独立完成任务"的说明**——那是给普通窗口的；你按下面的 Worker 协议工作。',
      '',
      '## 三级暗号（回传主大脑，必须遵守）',
      '',
      '任务推进中，**只在这三种情况**用暗号包裹你的汇报（日常代码块操作、中间步骤**不需要**回传）：',
      '',
      '- 进度：>>>MASTER_SYNC_START<<< ... >>>MASTER_SYNC_END<<<（主大脑知道你还在推进，绑定保留，你继续干活）',
      '- 完成：>>>MASTER_DONE_START<<< ... >>>MASTER_DONE_END<<<（主大脑验收，绑定解除）',
      '- 求助：>>>MASTER_ASK_START<<< ... >>>MASTER_ASK_END<<<（需主大脑决策，最高优先级）',
      '',
      '## 关键区分（易错点）',
      '',
      '- 【看门狗暗号】与【Worker 暗号】是两套东西：看门狗暗号（如【紫电青霜-7391】）只让本地看门狗停止催促，**不会**回传主大脑。',
      '- 回传主大脑**必须**用 >>>MASTER_xxx<<< 暗号，且 START/END **成对出现**。',
      '- 系统会自动把含暗号的回复转发给主大脑，你**不需要**知道 taskId，也**不需要**调用任何工具来汇报。',
      '',
      '## 汇报内容建议（重要）',
      '',
      'DONE 报告**必须按下面的 6 项结构化模板**填写，缺项会被主大脑追问：',
      '',
      '>>>MASTER_DONE_START<<<',
      '### 任务报告',
      '1. 任务目标：<一句话复述你被派的活>',
      '2. 实际做法：<关键步骤，2-4 条>',
      '3. 产物路径：<改/建的文件列表，绝对或相对路径>',
      '4. 验证结果：<测试/检查命令 + 实际输出摘要，如「npm test 353/353 通过」>',
      '5. 遗留问题：<无 / 具体问题>',
      '6. 自我评估：<对照验收标准，逐条说明达成情况；未达成要诚实说明>',
      '>>>MASTER_DONE_END<<<',
      '',
      'SYNC / ASK 保持简短：ASK 写清「需要主大脑决定什么 + 可选方案」，SYNC 一句话进度即可，无需完整模板。',
      '',
      '## 你是可复用的 Worker（重要）',
      '- 你是**综合能力型子 Agent**，没有固定身份。完成一个任务后，主大脑可能继续给你派**任意**新任务（不限于原模块）。',
      '- 收到新任务时，按新任务的目标/验收标准/约束执行，不要被上一轮任务的范围束缚。',
      '- 只要"忙得过来"就继续干；一个 Worker 同时只处理一个任务。',
      '- 主大脑可能用 team_reply_to_worker 在本对话内追加指令（不重开对话），此时延续当前上下文处理即可。',
    ].join(NL);
    finalPrompt = combined + NL + NL + '---' + NL + NL + workerProtocol + NL + NL + '# 你的任务' + NL + taskSuffix;
    logger.info('[TokFree] 已合并任务内容（含 Worker 协议），长度:', finalPrompt.length);
  }
  logger.info('[TokFree] 准备发送初始提示（不含目录树），长度:', finalPrompt.length);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('initial-prompt', finalPrompt);
  }
  stepLog('initial-prompt 已发送');

  return { success: true, message: '初始化完成，已发送系统提示词、工具规则和工具库' };
}

module.exports = { PROMPT_DIR, initProject };
