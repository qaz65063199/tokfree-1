/**
 * DeepSeek 拦截模式下的回复处理器（隔离世界）
 * 监听主世界注入的 'tokfree-ai-response' 事件，收到完整回复后走与 DOM 模式
 * 相同的工具调用/JS 代码块处理流程。
 */
const { extractJsToolBlocks, getJsCodeBlocksFromMarkdown, BT } = require('./js-detector');
const { tryParseToolCall } = require('./tool-parser');
const { handleToolCall, handleJsToolScript } = require('./observer');
const { sendToolResultToChat, sendCombinedJsResultsToChat, sendMessageToChat } = require('./chat-input');
const { hasTool, toolNamesList } = require('../tool-names');
const state = require('./state');
const { getProviderByUrl } = require('../../providers');

const MAX_JS_RETRY = 3;

/**
 * 上报 Worker 回报给主进程，带重试（双向确认：确保主进程真的收到）。
 * 失败重试最多 2 次（间隔 1 秒），仍失败则明确报错，不静默丢弃。
 */
async function reportWorkerResponseWithRetry(raw, taskId) {
  for (let i = 0; i <= 2; i++) {
    try {
      const r = await window.electronAPI.reportAiResponse(raw, taskId);
      if (r && r.success === false) {
        console.error('[TokFree] Worker 回报被主进程拒绝(' + ((r && r.error) || '未知') + ')，第 ' + (i + 1) + ' 次');
      } else {
        return true;
      }
    } catch (e) {
      console.error('[TokFree] Worker 回报失败，第 ' + (i + 1) + ' 次: ' + (e && e.message));
    }
    if (i < 2) await new Promise((res) => setTimeout(res, 1000));
  }
  console.error('[TokFree] Worker 回报最终失败（已重试），taskId=' + taskId);
  return false;
}
// 连续 XML 提示次数（防止无限循环）
let xmlHintCount = 0;
const XML_HINT_MAX = 10;
// 上次已处理的文本（去重，防同一条回复重复处理）
let lastProcessedText = '';
// 最近一次拦截到的完整回复文本（供手动解析、上下文压缩复用，不依赖 DOM）
let lastInterceptedText = '';
// 最近一次 hook 派发 'tokfree-ai-response'（finished）的时刻。
// 供 DOM 兜底判断"本轮生成期间拦截器是否真的派发过"：
// 若生成结束后该值仍早于本轮生成开始时刻，说明 hook 漏抓，需从 DOM 兜底提取。
let lastDispatchAt = 0;
// 上次上报给主进程的 token 累计量（节流：仅当变大时才再次上报，避免每次回复都 IPC）
let lastReportedTokens = 0;
// 上次已计入按天统计的累计 token 量（用于计算增量 delta）
let lastAccumulatedTokens = 0;

// ========== 截断即时续写 ==========
// 单条回复续写上限（滑动窗口内）
const CONTINUE_MAX = 3;
// 滑动窗口（毫秒）：窗口内达到上限即停止
const CONTINUE_WINDOW_MS = 60000;
// 续写提示词
const CONTINUE_PROMPT = '继续，直接输出剩余内容。不要重复已经输出过的内容，不要重新开始，从中断处接着写。';
// 续写前延迟（毫秒）
const CONTINUE_DELAY_MS = 1500;

/**
 * 判断回复是否明显被截断：未闭合的代码块（``` 计数为奇数）
 * 覆盖最常见场景（代码/文件内容被截断）。
 */
function looksTruncated(text) {
  if (!text || text.length < 100) return false;
  const matches = text.match(/```/g);
  if (!matches || matches.length % 2 === 0) return false;
  // 末尾必须是一个"未闭合代码块"的起始（其后有实质内容），才判定为截断，
  // 避免正文里偶尔提及单个 ``` 造成误判。
  const lastIdx = text.lastIndexOf('```');
  return (text.length - lastIdx) > 20;
}

/**
 * 尝试自动续写（滑动窗口限次，1 分钟内最多 CONTINUE_MAX 次）
 * @returns {boolean} 是否已安排续写
 */
function tryAutoContinue() {
  const now = Date.now();
  state.continueTimestamps = (state.continueTimestamps || []).filter(t => now - t < CONTINUE_WINDOW_MS);
  if (state.continueTimestamps.length >= CONTINUE_MAX) {
    console.log('[TokFree][拦截] 截断续写已达上限（' + (CONTINUE_WINDOW_MS / 1000) + '秒内 ' + CONTINUE_MAX + ' 次），停止');
    return false;
  }
  state.continueTimestamps.push(now);
  const nth = state.continueTimestamps.length;
  console.log('[TokFree][拦截] 检测到截断，' + CONTINUE_DELAY_MS + 'ms 后自动续写（第 ' + nth + '/' + CONTINUE_MAX + ' 次）');
  setTimeout(() => {
    sendMessageToChat(CONTINUE_PROMPT, '截断续写');
  }, CONTINUE_DELAY_MS);
  return true;
}


function looksLikeIncompleteCodeError(error) {
  if (!error || typeof error !== 'string') return false;
  return /SyntaxError|Missing initializer|Unexpected end of input|Unexpected token|Unexpected identifier|Unexpected reserved word|Invalid or unexpected token/i.test(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 执行 JS 代码块，遇到"代码不完整"错误时自动重试。
 * 拦截模式下文本已完整（finished），无需重新提取，简单重试执行即可。
 */
async function executeJsBlocksWithRetry(blocks) {
  let results = [];
  // 执行代码块期间标记 busy：看门狗不催促（代码块执行时页面静止，否则会被误判为停顿）
  try { if (window.electronAPI && window.electronAPI.watchdogBusy) window.electronAPI.watchdogBusy('代码块执行中', 600).catch(() => {}); } catch (_) {}
  // 标记"正在执行代码块"：用户此时插入的消息会排队，随下一个回执一起发
  state.executingJsBlocks = true;
  try {
    for (let attempt = 0; attempt <= MAX_JS_RETRY; attempt++) {
      results = [];
      for (const code of blocks) {
        const r = await handleJsToolScript(code);
        if (r) results.push(r);
      }
      const hasIncompleteFailure = results.some(
        (item) => item && item.result && !item.result.success && looksLikeIncompleteCodeError(item.result.error)
      );
      if (!hasIncompleteFailure) break;
      if (attempt < MAX_JS_RETRY) await sleep(1000);
    }
  } finally {
    state.executingJsBlocks = false;
    try { if (window.electronAPI && window.electronAPI.watchdogClearBusy) window.electronAPI.watchdogClearBusy().catch(() => {}); } catch (_) {}
  }
  return results;
}

/**
 * 处理一条已完成的 AI 回复文本
 * @param {string} text 完整回复文本（Markdown 原文）
 */
async function processInterceptedResponse(text, interrupted) {
  const raw = (text || '').trim();

  // 看门狗（方案 B）：
  // - 中断/截断 → 保持监护，10s 后催促
  // - 正常完成 → 由各分支决定：
  //     * 有工具调用 / JS 代码块（属于"进展"）→ disarm（随后回传会自动重新 arm）
  //     * 纯文本回复（无任何工具/代码块）→ 进入「完成确认」模式（5s 后催促）
  try {
    if (window.electronAPI && interrupted && window.electronAPI.watchdogInterrupted) {
      window.electronAPI.watchdogInterrupted().catch(() => {});
    }
  } catch (_) {}

  if (!raw) return;
  if (raw === lastProcessedText) return;
  lastProcessedText = raw;

  console.log('[TokFree][拦截] 收到完整回复，长度=' + raw.length + (interrupted ? '（截断信号）' : ''));

  // 会话计数：收到一条完整 AI 回复，记一次"接收"（已按文本去重）
  try {
    if (window.electronAPI && window.electronAPI.recordConversation) {
      window.electronAPI.recordConversation('received').catch(() => {});
    }
  } catch (_) {}

  // 看门狗：检测回复中是否出现限流提示；命中则标记冷却，避免硬撞限流。
  // 注意：必须用完整句式，且回复要"短"（纯提示才可能限流），否则正常对话里
  // 夹带"限制/频繁"等词会被误判、进入长时间冷却导致看门狗不催。
  try {
    const RATE_KW = ['请求过于频繁', '请求次数过多', '您已达到', '达到使用限制', '今日使用次数',
      '请稍后再试', '请稍后重试', '服务器繁忙', '服务繁忙', '系统繁忙',
      'rate limit exceeded', 'too many requests', 'please try again later',
      'usage limit', 'quota exceeded'];
    const lower = raw.toLowerCase();
    // 只有回复很短（<=300 字符）时，才可能是纯限流提示；长回复夹带这些词不算
    if (lower.length <= 300) {
      for (const kw of RATE_KW) {
        if (lower.indexOf(kw) !== -1) {
          console.log('[TokFree][拦截] 检测到限流提示[' + kw + ']，进入冷却');
          if (window.electronAPI.noteRateLimit) {
            window.electronAPI.noteRateLimit(kw).catch(() => {});
          }
          break;
        }
      }
    }
  } catch (_) {}

  // 【AI 协作】Worker 任务模式：先执行 tokfree 代码块（干活），再检查是否含汇报暗号。
  // 含代码块：执行代码块；若同时含暗号，一并上报。无代码块：仅当含暗号时上报。
  const __rptHas = (s, e) => raw.indexOf(s) !== -1 && raw.indexOf(e) !== -1;
  const __rptIsDone = __rptHas('>>>MASTER_DONE_START<<<', '>>>MASTER_DONE_END<<<');
  const __rptIsReport = __rptIsDone || __rptHas('>>>MASTER_ASK_START<<<', '>>>MASTER_ASK_END<<<') || __rptHas('>>>MASTER_SYNC_START<<<', '>>>MASTER_SYNC_END<<<');

  // 截断检测：仅当回复明显不完整（存在未闭合的 ``` 代码块）才续写。
  // 但含 Worker 汇报暗号时跳过续写：暗号表明这是终态汇报，必须立即上报主大脑，
  // 不能因报告里偶有未闭合代码块而触发"续写"、把上报推迟甚至丢失。
  if (!__rptIsReport && looksTruncated(raw)) {
    if (tryAutoContinue()) {
      if (window.electronAPI.watchdogReplied) window.electronAPI.watchdogReplied().catch(() => {});
      return;
    }
  }

  // 1. 优先检测 JS 工具代码块（tokfree / js 代码块）
  const jsBlocks = extractJsToolBlocks(raw);
  if (jsBlocks.length > 0) {
    console.log('[TokFree][拦截] 检测到 JS 工具代码块（' + jsBlocks.length + ' 个），开始执行');
    xmlHintCount = 0;
    // 工具循环看门狗：进入工具循环
    try { require('./tool-loop-watchdog').onToolCallDetected(); } catch (_) {}
    const results = await executeJsBlocksWithRetry(jsBlocks);
    if (results.length > 0) {
      sendCombinedJsResultsToChat(results);
      // 工具结果已回传 AI（=发消息等回复）→ 开看门狗计时
      try { require('./tool-loop-watchdog').onMessageSent(); } catch (_) {}
    }
    // 若本回复同时含汇报暗号，代码块执行完再一并上报主大脑
    if (state.currentWorkerTaskId && __rptIsReport) {
      console.log('[TokFree][拦截] 代码块执行后上报 Worker 回报, taskId=' + state.currentWorkerTaskId);
      try { await reportWorkerResponseWithRetry(raw, state.currentWorkerTaskId); } catch (e) {}
      if (__rptIsDone) { state.workerDoneReported = true; state.currentWorkerTaskId = null; }
    }
    if (window.electronAPI.watchdogReplied) window.electronAPI.watchdogReplied().catch(() => {});
    return;
  }

  // 2. Worker 回报（无代码块时）：仅当含暗号才上报主大脑
  if (state.currentWorkerTaskId && __rptIsReport) {
    console.log('[TokFree][拦截] 拦截到 Worker 任务回报, taskId=' + state.currentWorkerTaskId);
    try { await reportWorkerResponseWithRetry(raw, state.currentWorkerTaskId); } catch (e) {}
    if (__rptIsDone) { state.workerDoneReported = true; state.currentWorkerTaskId = null; }
    if (window.electronAPI.watchdogReplied) window.electronAPI.watchdogReplied().catch(() => {});
    return;
  }

  // 2. JSON 工具调用
  const toolCall = tryParseToolCall(raw);
  if (toolCall) {
    xmlHintCount = 0;
    if (!hasTool(toolCall.toolName)) {
      console.log('[TokFree][拦截] 工具不存在: ' + toolCall.toolName);
      sendToolResultToChat(
        toolCall,
        { success: false, error: '工具 ' + toolCall.toolName + ' 不存在，可用工具: ' + toolNamesList() }
      );
      return;
    }
    console.log('[TokFree][拦截] 工具存在: ' + toolCall.toolName + ', 开始执行');
    await handleToolCall(toolCall);
    if (window.electronAPI.watchdogReplied) window.electronAPI.watchdogReplied().catch(() => {});
    return;
  }

  // 3. XML 格式工具调用提示
  const hasAntmlXml = /^<\s*｜｜DSML｜｜/i.test(raw);
  const hasXmlInvoke = /<\s*(?:[\w-]+:)?invoke\s+name=/i.test(raw);
  const hasXmlClose = /<\s*\/\s*(?:[\w-]+:)?invoke\s*>/i.test(raw);
  const hasXmlParam = /<\s*(?:[\w-]+:)?parameter\s+name=/i.test(raw);
  if (hasAntmlXml || (hasXmlInvoke && (hasXmlClose || hasXmlParam))) {
    if (xmlHintCount >= XML_HINT_MAX) {
      console.log('[TokFree][拦截] 已连续提示 ' + xmlHintCount + ' 次 XML 格式，停止发送');
      return;
    }
    xmlHintCount++;
    console.log('[TokFree][拦截] 检测到 XML 格式工具调用（第 ' + xmlHintCount + ' 次提示）');
    sendMessageToChat(
      '请使用' + BT + BT + BT + 'tokfree' + BT + BT + BT + ' 代码块进行工具调用，不要使用 XML invoke 格式。',
      'XML工具调用提示'
    );
    if (window.electronAPI.watchdogReplied) window.electronAPI.watchdogReplied().catch(() => {});
    return;
  }

  // 4. 普通文本回复（无工具调用 / 无 JS 代码块）
  console.log('[TokFree][拦截] 正常文本回复，未检测到工具调用');
  // 本地 OpenAI 兼容 API：若当前有挂起的 API 请求，把这条回复回传主进程 resolve。
  // 放在最前面：API 场景的目标就是"拿到网页 AI 的纯文本回复"，拿到即上报并清空 id。
  if (state.currentApiRequestId) {
    const __apiReqId = state.currentApiRequestId;
    state.currentApiRequestId = null;
    try {
      if (window.electronAPI && typeof window.electronAPI.reportApiResponse === 'function') {
        window.electronAPI.reportApiResponse(__apiReqId, raw).catch((e) => {
          console.error('[TokFree][API] 回传回复失败:', e && e.message);
        });
        console.log('[TokFree][API] 已回传网页 AI 回复 requestId=' + __apiReqId + ', 长度=' + raw.length);
      }
    } catch (e) {
      console.error('[TokFree][API] 回传回复异常:', e && e.message);
    }
  }
  // 工具循环看门狗：纯文本回复 = 退出工具循环
  try { require('./tool-loop-watchdog').exitToolLoop(); } catch (_) {}

  // 兜底：AI 完成纯文本回复后，若仍有排队的用户消息 → 单独发出
  try {
    if (Array.isArray(state.pendingUserMessages) && state.pendingUserMessages.length > 0) {
      const { drainPendingUserMessages } = require('./chat-input');
      const extra = drainPendingUserMessages();
      if (extra) {
        console.log('[TokFree][拦截] 纯文本回复完成，发送排队的用户补充');
        sendMessageToChat(extra, '用户补充');
      }
    }
  } catch (e) { console.error('[TokFree][拦截] 发送排队用户消息失败:', e.message); }

  // 看门狗「完成确认」：仅对纯文本回复触发（满足前提 1：不运行 JS 且无代码块）。
  // 若回复含通用代码块（```），视为"仍有产出"，不催促，直接 disarm。
  try {
    const hasFence = raw.indexOf(BT + BT + BT) !== -1;
    if (hasFence) {
      if (window.electronAPI.watchdogReplied) window.electronAPI.watchdogReplied().catch(() => {});
    } else if (window.electronAPI.watchdogScheduleConfirm) {
      window.electronAPI.watchdogScheduleConfirm(raw).catch(() => {});
    } else if (window.electronAPI.watchdogReplied) {
      window.electronAPI.watchdogReplied().catch(() => {});
    }
  } catch (_) {}

  try {
    try { if (localStorage.getItem('tokfree-notify-enabled') !== '0') window.electronAPI.showAiNotification().catch(() => {}); } catch (_) { window.electronAPI.showAiNotification().catch(() => {}); }
  } catch (e) { /* ignore */ }
}

// 回复完成监听器（供上下文压缩等流程等待 AI 回复完成）
const responseListeners = new Set();
const errorListeners = new Set();

/**
 * 注册"AI 回复完成"监听器
 * @param {Function} cb 收到完成回复时调用，参数为完整文本
 * @returns {Function} 取消注册
 */
function onInterceptedResponse(cb) {
  responseListeners.add(cb);
  return () => responseListeners.delete(cb);
}

/** 注册"AI 请求失败"监听器（供重试引擎） */
function onAiError(cb) {
  errorListeners.add(cb);
  return () => errorListeners.delete(cb);
}

/**
 * 启动拦截事件监听
 */
function startInterceptObserver() {
  window.addEventListener('tokfree-ai-response', (ev) => {
    try {
      const detail = ev && ev.detail;
      if (!detail) return;
      // 用户主动停止：不处理，也不通知监听器（避免误判失败触发重试）
      if (detail.status === 'stopped') {
        try { require('./tool-loop-watchdog').onResponseReceived('stopped'); } catch (_) {}
        // 区分「用户主动停」与「AI 中断」：
        //   用户主动停 → disarm（用户知情，不催）
        //   AI 中断/截断 → 保持监护，交给看门狗催
        if (detail.userStopped) {
          console.log('[TokFree][拦截] 用户主动停止，解除监护');
          try { if (window.electronAPI && window.electronAPI.watchdogReplied) window.electronAPI.watchdogReplied().catch(() => {}); } catch (_) {}
          return;
        }
        console.log('[TokFree][拦截] AI 中断/截断，保持监护待催');
        try { if (window.electronAPI && window.electronAPI.watchdogInterrupted) window.electronAPI.watchdogInterrupted().catch(() => {}); } catch (_) {}
        return;
      }
      if (!detail.finished) return;
      // 记录 hook 派发时刻：DOM 兜底据此判断本轮是否已由拦截器处理过
      // ⚠️ 仅当 hook 派发了非空正文时才刷新：qwen-hook 的 phase 过滤可能把正文误判为
      //    噪声导致 text 为空，此时若刷新会让 DOM 兜底误以为"hook 已派发"而放弃兜底，
      //    造成代码块永不执行。空文本时不刷新，兜底仍会从 DOM 提取真实回复。
      if ((detail.text || '').trim()) lastDispatchAt = Date.now();
      try { require('./tool-loop-watchdog').onResponseReceived('finished'); } catch (_) {}
      // 缓存最近一次完整回复文本，供手动解析 / 上下文压缩复用（不依赖 DOM）
      lastInterceptedText = detail.text || '';
      // 保存服务端权威 token 统计（供面板显示）
      if (detail.tokenUsage) {
        state.serverTokenUsage = detail.tokenUsage;
        // 上报 token 用量给主进程（供主大脑感知子 Agent 消耗）
        // 节流：仅当累计量变大时才上报；失败静默，绝不影响主流程。
        try {
          const count = detail.tokenUsage.accumulatedTokens;
          if (typeof count === 'number' && count > 0 && count > lastReportedTokens) {
            lastReportedTokens = count;
            if (window.electronAPI && typeof window.electronAPI.reportTokenUsage === 'function') {
              window.electronAPI.reportTokenUsage(count).catch(() => {});
            }
          }
          // 计算本次增量并上报（供按天累计统计）：
          //   count 为会话累计值；若比上次小视为会话重置，增量取本次 count。
          if (typeof count === 'number' && count > 0) {
            const delta = count >= lastAccumulatedTokens ? (count - lastAccumulatedTokens) : count;
            lastAccumulatedTokens = count;
            if (delta > 0 && window.electronAPI && typeof window.electronAPI.reportTokenDelta === 'function') {
              window.electronAPI.reportTokenDelta(delta).catch(() => {});
            }
          }
        } catch (_) { /* 上报失败静默 */ }
      }
      // 保存最近一次回复的消息 id（供上下文压缩定位摘要用）
      if (detail.msgIds) {
        state.lastResponseMsgIds = detail.msgIds;
      }
      // 优化3：中断/截断且正文为空或极短 → 视为失败，派发可被重试引擎识别的信号，
      // 并跳过成功回调（避免误重置重试计数）。用户主动停止已在上方 status==='stopped' 分支返回。
      try {
        const __txt = (detail.text || '').trim();
        if (detail.interrupted === true && __txt.length <= 2) {
          console.log('[TokFree][拦截] 检测到中断且正文为空，派发重试信号');
          const __d = { reason: 'interrupted', interrupted: true, text: __txt, sessionId: detail.sessionId };
          for (const cb of errorListeners) { try { cb(__d); } catch (_) {} }
          return;
        }
      } catch (_) { /* ignore */ }
      // 通知"回复完成"监听器（上下文压缩等待 AI 回复用）
      for (const cb of responseListeners) {
        try { cb(detail.text || ''); } catch (_) { /* ignore */ }
      }
      processInterceptedResponse(detail.text, detail.interrupted);
    } catch (err) {
      console.error('[TokFree][拦截] 处理回复事件出错:', err);
    }
  });
  window.addEventListener('tokfree-ai-error', (ev) => {
    try {
      const detail = (ev && ev.detail) || {};
      try { require('./tool-loop-watchdog').onResponseReceived('error'); } catch (_) {}
      for (const cb of errorListeners) {
        try { cb(detail); } catch (_) { /* ignore */ }
      }
    } catch (err) {
      console.error('[TokFree][拦截] 处理失败事件出错:', err);
    }
  });
  console.log('[TokFree][拦截] 已启动 tokfree-ai-response / tokfree-ai-error 事件监听');
}

/** 取最近一次拦截到的完整回复文本（手动解析 / 上下文压缩用） */
function getLastInterceptedText() {
  return lastInterceptedText;
}

/** 取最近一次 hook 派发时刻（DOM 兜底判断本轮是否已派发用） */
function getLastDispatchAt() {
  return lastDispatchAt;
}

/**
 * DOM 兜底提取：拦截模式下 hook 漏抓时，从 DOM 读取最后一条 AI 消息，
 * 走与 hook 正常路径相同的处理流程（processInterceptedResponse）。
 *
 * 触发时机：preload/index.js 的按钮态轮询检测到「生成中 → 停止」边沿，
 * 且本轮生成期间 hook 未派发过（lastDispatchAt 早于本轮生成开始时刻）。
 *
 * 安全（防重复执行代码块）：
 * - processInterceptedResponse 内部用 lastProcessedText 去重：DOM 文本若与
 *   hook 已处理的文本一致则直接 return，不重复执行。
 * - 仅当 hook 漏抓（lastDispatchAt 未刷新）时才被调用，正常派发时不会触发。
 *
 * @param {number} generatingStartAt 本轮生成开始时刻（ms）
 * @returns {Promise<boolean>} 是否执行了兜底提取
 */
async function fallbackProcessFromDom(generatingStartAt) {
  // 仅当 hook 派发的文本含代码块（含 ``` 围栏或 tokfree 标记）时，才认为它真的处理了可执行内容，抑制兜底；
  // 否则（hook 只派发了短片段/纯文本），即使 lastDispatchAt 刷新了也要兜底。
  const hookHadCode = /```|tokfree/.test(lastInterceptedText || '');
  if (lastDispatchAt && lastDispatchAt >= (generatingStartAt || 0) && hookHadCode) return false;
  try {
    const provider = getProviderByUrl(window.location.href);
    if (!provider || typeof provider.getMessageCandidates !== 'function') return false;
    const cands = provider.getMessageCandidates();
    if (!cands || !cands.length) return false;
    // 从后往前找第一条有内容的 AI 消息（保留 DOM 元素，供结构化提取代码块）
    let md = null;
    let text = '';
    for (let i = cands.length - 1; i >= 0; i--) {
      const el = cands[i];
      if (provider.isUserMessage && provider.isUserMessage(el)) continue;
      let node = el;
      try { if (typeof provider.getMessageMarkdown === 'function') node = provider.getMessageMarkdown(el) || el; } catch (_) { node = el; }
      const t = String((node && (node.innerText || node.textContent)) || '').trim();
      if (t) { md = node; text = t; break; }
    }
    if (!text) return false;

    // 结构化路径优先：Monaco 渲染（Qwen 新版）的 DOM innerText 无代码围栏，
    // 文本路径（extractJsToolBlocks）提取不到代码块；改从 <pre> + Monaco
    // .view-lines/.view-line 结构化提取代码 + 从 header 提语言。
    const allStructuredBlocks = getJsCodeBlocksFromMarkdown(md);
    if (allStructuredBlocks.length > 0) {
      if (text === lastProcessedText) return false;
      // 防重复：逐块检查代码内容是否已出现在 hook 派发的文本里（hook 已处理过则跳过）。
      // hook 文本含围栏、结构化块是纯代码，用 indexOf 检查代码是否为子串即可。
      const structuredBlocks = allStructuredBlocks.filter((block) => {
        return !block || (lastInterceptedText || '').indexOf(block) === -1;
      });
      // 全部块都已由 hook 处理过 → 不兜底，避免重复执行
      if (structuredBlocks.length === 0) return false;
      lastProcessedText = text;
      console.log('[TokFree][拦截] hook 未派发，DOM 兜底结构化提取代码块（' + structuredBlocks.length + ' 个），开始执行');
      try { require('./tool-loop-watchdog').onToolCallDetected(); } catch (_) {}
      const results = await executeJsBlocksWithRetry(structuredBlocks);
      if (results.length > 0) {
        sendCombinedJsResultsToChat(results);
        try { require('./tool-loop-watchdog').onMessageSent(); } catch (_) {}
      }
      const __has = (s, e) => text.indexOf(s) !== -1 && text.indexOf(e) !== -1;
      const __done = __has('>>>MASTER_DONE_START<<<', '>>>MASTER_DONE_END<<<');
      const __report = __done || __has('>>>MASTER_ASK_START<<<', '>>>MASTER_ASK_END<<<') || __has('>>>MASTER_SYNC_START<<<', '>>>MASTER_SYNC_END<<<');
      if (state.currentWorkerTaskId && __report) {
        try { await reportWorkerResponseWithRetry(text, state.currentWorkerTaskId); } catch (e) {}
        if (__done) { state.workerDoneReported = true; state.currentWorkerTaskId = null; }
      }
      try { if (window.electronAPI && window.electronAPI.watchdogReplied) window.electronAPI.watchdogReplied().catch(() => {}); } catch (_) {}
      return true;
    }

    // 无结构化代码块 → 回退文本路径（与 hook 正常路径同款处理）
    if (text === lastProcessedText) return false;
    console.log('[TokFree][拦截] hook 未派发，DOM 兜底提取最后一条 AI 回复，长度=' + text.length);
    await processInterceptedResponse(text, false);
    return true;
  } catch (e) {
    console.error('[TokFree][拦截] DOM 兜底提取失败: ' + (e && e.message));
    return false;
  }
}

module.exports = { startInterceptObserver, processInterceptedResponse, getLastInterceptedText, getLastDispatchAt, fallbackProcessFromDom, onInterceptedResponse, onAiError };
