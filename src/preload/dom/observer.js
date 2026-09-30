/**
 * 回复解析主流程：MutationObserver、完成检测、工具/JS 脚本执行
 * 由原 preload.js 拆分而来，逻辑保持不变。
 */
const {
  showOverlay, setTaskStatus, showToast, showConfirmDialog, addHistory, flashBadge, truncate, displayCommand, generateId,
} = require('../overlay/ui');
const { scanForCommands } = require('./detector');
const { tryParseToolCall } = require('./tool-parser');
const { getJsCodeBlocksFromMarkdown, looksLikeIncompleteCodeError, hasOnlyCodeContent, FENCE } = require('./js-detector');
const { sendToolResultToChat, sendCombinedJsResultsToChat, sendMessageToChat } = require('./chat-input');
const { isAIResponseComplete } = require('./ai-response');
const { getProviderByUrl } = require('../../../src/providers');
const { hasTool, toolNamesList } = require('../tool-names');
const state = require('./state');

/**
 * 手动解析按钮点击处理
 * 用户点击后，仅解析最后一条 AI 回复中的工具调用并执行
 */
async function triggerManualParseAttention() {
  const btn = document.getElementById('tokfree-btn-manual-parse');
  if (btn) {
    btn.classList.remove('tokfree-btn-attention');
    // 强制回流以重新触发动画
    void btn.offsetWidth;
    btn.classList.add('tokfree-btn-attention');
    // 动画结束后移除类，避免状态残留
    setTimeout(() => {
      btn.classList.remove('tokfree-btn-attention');
    }, 3500);
  }
}

// 是否正在执行命令或工具（供手动解析等入口判断）
let isExecuting = false;

// 手动解析按钮的防连点状态
let manualParseBusy = false;
let manualParseLastAt = 0;

async function handleManualParse() {
  if (isExecuting || manualParseBusy) {
    showToast('命令正在执行中，稍等', 3000);
    return;
  }
  // 防连点：2 秒内重复点击直接忽略，避免疯狂重复发送
  const now = Date.now();
  if (now - manualParseLastAt < 2000) return;
  manualParseLastAt = now;

  const btn = document.getElementById('tokfree-btn-manual-parse');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '发送中...';
  }

  manualParseBusy = true;
  try {
    // 拦截模式下回复已由拦截器自动处理（含 JS 代码块执行），手动按钮不再
    // 重新解析/执行代码块，只负责催 AI 继续——否则会重复执行 + 重复回传，
    // 形成"疯狂发消息"。
    const provider = getCurrentProvider();
    const useIntercept = !!(provider && provider.useIntercept);
    // AI 正在生成/执行代码块时不是"卡住"，此时催促会打断它
    try {
      const { isAiBusy } = require('./chat-input');
      if (isAiBusy()) { showToast('AI 正在工作，无需催促', 2500); return; }
    } catch (_) {}

    let parsed = false;
    if (!useIntercept) {
      // ① DOM 模式：尝试解析最后一条 AI 回复中的未执行工具调用
      // 已处理过的消息不再重跑（force=true 会跳过去重，导致重复执行 + 重复回传）
      try {
        const cands = getMessageCandidates();
        const last = cands.length > 0 ? cands[cands.length - 1] : null;
        if (last && !processedMessages.has(last)) {
          parsed = processLatestAIResponse(0, true) === true;
        }
      } catch (_) {}
    }

    if (parsed) {
      showToast('已重新执行未处理的工具调用', 3000);
      return;
    }

    // ② 没有可执行的工具调用（AI 真的停住了）→ 发送"继续"指令催它往下做
    const { sendToChat } = require('./chat-input');
    const __ci = require('./chat-input');
    if (__ci.flushPendingSend && __ci.flushPendingSend()) { showToast('已发送待回传的工具结果', 3000); return; }
    await sendToChat('刚才卡住了，请从中断处继续，不要停在半途；如果已完成请说明。爱你哦', '卡住催促', 600);
    showToast('已发送「继续」指令', 3000);
  } catch (err) {
    console.error('[TokFree] 卡住处理出错:', err);
    showToast('处理出错: ' + (err && err.message), 3000);
  } finally {
    manualParseBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = '卡住了？点我'; }
  }
}
// ========== MutationObserver ==========

// 已处理过的消息节点集合（避免重复处理）
let processedMessages = new WeakSet();

// 已计入"接收"统计的消息节点（防 force/重试导致重复计数）
let countedReceived = new WeakSet();
function markReceived(msg) {
  if (!msg || countedReceived.has(msg)) return;
  countedReceived.add(msg);
  try {
    if (window.electronAPI && window.electronAPI.recordConversation) {
      window.electronAPI.recordConversation('received').catch(() => {});
    }
  } catch (_) {}
  // 看门狗 disarm 已下沉到各分支：
  // - 有工具/代码块（进展）→ disarm
  // - 纯文本回复 → 进入"完成确认"模式（方案 B）
}

/** 看门狗：标记为"进展"（有工具/代码块），退出监护 */
function wdProgress() {
  try {
    if (window.electronAPI && window.electronAPI.watchdogReplied) {
      window.electronAPI.watchdogReplied().catch(() => {});
    }
  } catch (_) {}
}

/** 看门狗：纯文本回复 → 进入完成确认模式（含暗号检测与上限） */
function wdConfirm(text) {
  try {
    if (window.electronAPI && window.electronAPI.watchdogScheduleConfirm) {
      window.electronAPI.watchdogScheduleConfirm(text).catch(() => {});
    } else if (window.electronAPI && window.electronAPI.watchdogReplied) {
      window.electronAPI.watchdogReplied().catch(() => {});
    }
  } catch (_) {}
}

// JS 代码块稳定性校验状态：msg → {snapshot, blocksSig, lastChange}
// 由 mutation 驱动更新；interval 兜底在内容稳定满窗口后执行，不依赖单次 setTimeout（智谱等 SPA 下不可靠）
let jsStability = new Map();
let stabilityTimer = null;

// 连续 XML 提示次数（防止 AI 持续用 XML 格式回复导致无限循环）
let xmlHintCount = 0;
const XML_HINT_MAX = 10;

// 重置已处理状态（URL 切换/新会话时调用）
function resetProcessedState() {
  processedMessages = new WeakSet();
  countedReceived = new WeakSet();
  jsStability = new Map();
  if (stabilityTimer) {
    clearInterval(stabilityTimer);
    stabilityTimer = null;
  }
  xmlHintCount = 0;
}

// 内容不完整时的最大重试次数（AI 生成长内容可能需 30 秒+）
const MAX_RETRY_COUNT = 2;
// 重试间隔（ms）
const RETRY_INTERVAL = 2000;
// JS 代码块稳定确认窗口（ms）
const JS_STABILITY_WINDOW = 800;
// interval 兜底轮询间隔（ms）
const STABILITY_POLL_INTERVAL = 500;
/**
 * 检查字符串是否为"疑似工具调用但内容不完整"
 * 规则：文本包含 { 且含工具调用特征（toolName/工具名/大括号开头），
 * 则从第一个 { 开始检查括号配对；配对不完整返回 false（需要重试）
 */
function isJsonBalanced(str) {
  const trimmed = (str || '').trim();
  // 不含 { 或没有工具调用特征 → 不是工具调用，直接通过
  if (!trimmed.includes('{')) return true;
  if (!/toolName|"tool"|file_|json复制|```/.test(trimmed) && !trimmed.trimStart().startsWith('{')) {
    return true;
  }
  // 从第一个 { 开始检查括号配对
  const jsonPart = trimmed.substring(trimmed.indexOf('{'));
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;
  for (const char of jsonPart) {
    if (escapeNext) { escapeNext = false; continue; }
    if (char === '\\') { escapeNext = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (!inString) {
      if (char === '{') braceCount++;
      else if (char === '}') {
        braceCount--;
        if (braceCount < 0) return true; // 多出的 }，视为异常但不再等
      }
    }
  }
  return braceCount === 0;
}
/**
 * 获取当前平台 Provider（若未识别则返回 null）
 */
function getCurrentProvider() {
  return getProviderByUrl(window.location.href);
}

/**
 * 获取当前平台消息容器元素列表（过滤用户消息）
 */
function getMessageCandidates() {
  const provider = getCurrentProvider();
  if (!provider || typeof provider.getMessageCandidates !== 'function') return [];
  return provider.getMessageCandidates();
}

/**
 * 获取消息容器中的回复内容根节点
 */
function getMessageMarkdown(messageEl) {
  const provider = getCurrentProvider();
  if (!provider || typeof provider.getMessageMarkdown !== 'function') return messageEl;
  return provider.getMessageMarkdown(messageEl);
}

/**
 * 执行 JS 代码块，遇到"代码不完整"类错误时自动重试。
 * 策略：等待 1 秒后重新从 markdown 获取最新代码块，最多重试 3 次。
 * 仍失败则把最终报错回传 AI。
 * @param {Array<string>} initialBlocks 初始提取的代码块
 * @param {Element} markdown 消息 markdown 根节点
 * @param {boolean} force 是否手动解析模式
 */
async function executeJsBlocksWithRetry(initialBlocks, markdown, force) {
  let blocks = initialBlocks;
  let results = [];
  const MAX_JS_RETRY = 3;

  // 执行代码块期间标记 busy：看门狗不催促（代码块执行时页面静止，否则会被误判为停顿）
  try { if (window.electronAPI && window.electronAPI.watchdogBusy) window.electronAPI.watchdogBusy('代码块执行中', 600).catch(() => {}); } catch (_) {}
  try {
  for (let attempt = 0; attempt <= MAX_JS_RETRY; attempt++) {
    results = [];
    for (const code of blocks) {
      const r = await handleJsToolScript(code);
      if (r) results.push(r);
    }

    const hasIncompleteFailure = results.some(
      item => item && item.result && !item.result.success && looksLikeIncompleteCodeError(item.result.error)
    );

    if (!hasIncompleteFailure) break;

    if (attempt < MAX_JS_RETRY) {
      console.log('[' + new Date().toISOString() + '] [TokFree] ⏳ 代码不完整，等待 1 秒后重新获取并重试（' + (attempt + 1) + '/' + MAX_JS_RETRY + '）...');
      await sleep(1000);
      console.log('[' + new Date().toISOString() + '] [TokFree] ⏳ 等待结束，开始第 ' + (attempt + 1) + ' 次重试');
      blocks = getJsCodeBlocksFromMarkdown(markdown);
    }
  }

  const stillIncomplete = results.some(
    item => item && item.result && !item.result.success && looksLikeIncompleteCodeError(item.result.error)
  );
  if (stillIncomplete) {
    console.log('[' + new Date().toISOString() + '] [TokFree] ⚠️ 代码不完整，已重试 ' + MAX_JS_RETRY + ' 次仍失败，将报错回传 AI');
  }
  if (results.length > 0) sendCombinedJsResultsToChat(results);
  } finally {
    try { if (window.electronAPI && window.electronAPI.watchdogClearBusy) window.electronAPI.watchdogClearBusy().catch(() => {}); } catch (_) {}
  }
}
/**
 * 稳定性 interval 兜底：mutation 驱动可能因 SPA 宏任务风暴而漏触发，
 * 这里每 STABILITY_POLL_INTERVAL 检查一次，内容稳定满 JS_STABILITY_WINDOW 即执行。
 * 与 mutation 通道共享 jsStability 快照；执行后按消息预标记，防止双通道重复处理。
 */
function ensureStabilityTimer() {
  if (stabilityTimer) return;
  stabilityTimer = setInterval(() => {
    const now = Date.now();
    let needRescan = false;
    for (const [msg, rec] of jsStability) {
      // 节点已被页面卸载：清理
      if (typeof msg.isConnected === 'boolean' && !msg.isConnected) {
        jsStability.delete(msg);
        // ChatGPT 等 React 应用流式渲染会替换消息节点，旧节点 isConnected 变 false。
        // 若该节点尚未执行（卡在稳定性校验期间被替换），需重新扫描新节点，
        // 否则新节点不会被稳定性通道跟踪，导致工具永不执行。
        // 已执行过的节点则不再扫描，避免重渲染后被重复执行。
        if (!processedMessages.has(msg)) needRescan = true;
        continue;
      }
      if (now - rec.lastChange >= JS_STABILITY_WINDOW) {
        jsStability.delete(msg);
        if (processedMessages.has(msg)) continue; // 已被其他通道处理
        processedMessages.add(msg);
        // 内容已稳定满窗口 → force 直接执行（避免重新 set 快照导致死循环）
        processLatestAIResponse(0, true);
      }
    }
    // 有未执行节点被替换卸载 → 重新扫描最新消息，跟踪新节点
    if (needRescan) {
      processLatestAIResponse(0, false);
    }
    if (jsStability.size === 0) {
      clearInterval(stabilityTimer);
      stabilityTimer = null;
    }
  }, STABILITY_POLL_INTERVAL);
}


/**
 * 回复结束后，获取最新一条 AI 回复的内容并解析工具调用
 * @param {number} retryCount 当前重试次数（内容不完整时延迟重试）
 */
function processLatestAIResponse(retryCount = 0, force = false) {
  const messages = getMessageCandidates();
  const nowIso = new Date().toISOString();
  console.log('[' + nowIso + '] [DEBUG] messages count=' + messages.length);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    console.log('[' + nowIso + '] [DEBUG] [' + i + '] cls=' + ((m.className || m.tagName || '').toString().slice(0, 60)) + ' text=' + ((m.textContent || '').trim().slice(0, 50)));
  }
  if (messages.length === 0) {
    console.log('[TokFree] 未找到 AI 消息节点');
    return;
  }

  // 从后往前找第一条有实际内容的 AI 消息，跳过空消息
  let lastMessage = null;
  let markdown = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i];
    const md = getMessageMarkdown(candidate);
    const hasContent = md && (md.textContent || '').trim().length > 0;
    if (hasContent) {
      lastMessage = candidate;
      markdown = md;
      break;
    }
  }
  if (!lastMessage || !markdown) {
    console.log('[TokFree] 未找到有内容的 AI 回复');
    return;
  }

  if (!force && processedMessages.has(lastMessage)) {
    return; // 已处理过，跳过
  }

  // 跳过用户消息（其中包含系统提示词里的示例代码块，不应被执行）
  const providerForUser = getCurrentProvider();
  if (providerForUser && typeof providerForUser.isUserMessage === 'function' && providerForUser.isUserMessage(lastMessage)) {
    processedMessages.add(lastMessage);
    console.log('[TokFree] ⏭ 跳过用户消息（包含系统提示词示例）');
    return;
  }

  // 会话计数：确认这是一条 AI 回复后，记一次"接收"（WeakSet 防重）
  markReceived(lastMessage);

  // Worker 回报暗号检测（用于代码块执行后一并上报主大脑）
  const __wText = markdown.textContent || '';
  const __wHas = (s, e) => __wText.indexOf(s) !== -1 && __wText.indexOf(e) !== -1;
  const __wIsDone = __wHas('>>>MASTER_DONE_START<<<', '>>>MASTER_DONE_END<<<');
  const __wIsReport = __wIsDone || __wHas('>>>MASTER_ASK_START<<<', '>>>MASTER_ASK_END<<<') || __wHas('>>>MASTER_SYNC_START<<<', '>>>MASTER_SYNC_END<<<');

  // 优先检测 JS 工具代码块（tokfree 代码块 / 调用工具函数的 js 代码块）
  const jsBlocks = getJsCodeBlocksFromMarkdown(markdown);
  console.log('[DEBUG][processLatest] lastMessage=' + (lastMessage.className || lastMessage.tagName) +
    ' markdown=' + (markdown.className || markdown.tagName) +
    ' jsBlocks=' + jsBlocks.length +
    ' force=' + force +
    ' retryCount=' + retryCount);
  if (jsBlocks.length > 0) {
    // 稳定性双通道校验：流式渲染期间代码块只渲染了一半（曾导致 "const content"
    // 这样的残缺代码被执行 → SyntaxError）。mutation 驱动 + interval 兜底，
    // 内容稳定满 JS_STABILITY_WINDOW 后执行，不依赖单次 setTimeout（智谱等 SPA 下不可靠）。
    if (force) {
      // 手动解析：跳过稳定性校验，直接执行（标记已处理，避免同节点重复自动执行）
      processedMessages.add(lastMessage);
      console.log('[TokFree] 手动解析模式，跳过稳定性校验');
      executeJsBlocksWithRetry(jsBlocks, markdown, true);
      wdProgress();
      return true;
    }

    const snapshot = markdown.textContent || '';
    const blocksSig = jsBlocks.map((b) => b.length).join(',');
    const now = Date.now();
    const rec = jsStability.get(lastMessage);
    if (!rec || rec.snapshot !== snapshot || rec.blocksSig !== blocksSig) {
      // 内容仍在变化：记录快照，等待下一次 mutation / interval 复查
      jsStability.set(lastMessage, { snapshot, blocksSig, lastChange: now });
      ensureStabilityTimer();
      console.log('[TokFree] ⏳ 检测到 JS 工具代码块，流式渲染中，等待稳定...');
      return; // 不标记 processed，稳定后执行
    }

    // 内容一致：需稳定满窗口确认
    if (now - rec.lastChange < JS_STABILITY_WINDOW) {
      console.log('[TokFree] ⏳ JS 代码块稳定中（等待 ' + JS_STABILITY_WINDOW + 'ms 确认）...');
      return;
    }

    // 稳定满窗口 → 执行
    jsStability.delete(lastMessage);
    processedMessages.add(lastMessage);
    console.log('[TokFree] ✅ 代码块稳定，检测到 JS 工具代码块（' + jsBlocks.length + ' 个），开始执行');
    // 正确使用 tokfree 代码块，重置 XML 提示计数
    xmlHintCount = 0;
    executeJsBlocksWithRetry(jsBlocks, markdown, false);
    // 若本回复同时含汇报暗号，代码块执行后一并上报主大脑
    if (state.currentWorkerTaskId && __wIsReport) {
      console.log('[TokFree] 代码块执行后上报 Worker 回报 (DOM模式), taskId=' + state.currentWorkerTaskId);
      try { window.electronAPI.reportAiResponse(__wText, state.currentWorkerTaskId).catch(() => {}); } catch (e) {}
      if (__wIsDone) state.currentWorkerTaskId = null;
    }
    // 看门狗：代码块属于"进展"（正在运行 JS），不催促
    wdProgress();
    return;
  }

  // 无 JS 代码块：文本也可能仍在流式渲染中（先文字后代码块 / 代码块中途不完整）。
  // 若直接处理，会因"疑似工具但未识别"或"普通文本"提前标记 processed，
  // 导致同一条消息后续渲染出的完整代码块被永久跳过（智谱等 SPA 回复中途
  // isResponseComplete 即可能返回 true）。与 JS 块共用稳定性通道。
  if (!force) {
    const snapshot = markdown.textContent || '';
    const now = Date.now();
    const rec = jsStability.get(lastMessage);
    if (!rec || rec.snapshot !== snapshot) {
      jsStability.set(lastMessage, { snapshot, blocksSig: 'text', lastChange: now });
      ensureStabilityTimer();
      console.log('[TokFree] ⏳ 文本内容渲染中，等待稳定（防流式中途漏检）...');
      return;
    }
    if (now - rec.lastChange < JS_STABILITY_WINDOW) {
      console.log('[TokFree] ⏳ 文本内容稳定中（等待 ' + JS_STABILITY_WINDOW + 'ms 确认）...');
      return;
    }
    jsStability.delete(lastMessage);
  }

  // 提取文本：
  // - 整条回复只包含代码块 → 从 pre code 提取（纯净，避免工具栏文字）
  // - 否则取完整 markdown 文本（剔除工具栏），不能只取 code，
  //   否则会丢弃 AI 的解释正文（曾导致 ChatGPT 工具回传异常）
  let text = '';
  const codeEl = markdown.querySelector('pre code');
  if (codeEl && hasOnlyCodeContent(markdown)) {
    text = (codeEl.textContent || codeEl.innerText || '').trim();
    console.log('[TokFree] 提取方式: pre code 元素（整条回复仅代码块）');
  } else {
    const clone = markdown.cloneNode(true);
    clone.querySelectorAll('button, [class*="toolbar"], [class*="copy"], [class*="download"], [class*="code-block-header"], [class*="lang"], [class*="header"]').forEach(el => el.remove());
    text = (clone.textContent || clone.innerText || '').trim();
    console.log('[TokFree] 提取方式: 完整文本(剔除工具栏)');
  }

  if (!text) {
    console.log('[DEBUG][processLatest] 提取文本为空');
    return;
  }
  console.log('[DEBUG][processLatest] text长度=' + text.length + ' 前60字符=' + JSON.stringify(text.slice(0, 60)));
  console.log(text);

  // 看门狗：检测回复中是否出现限流提示；命中则标记冷却，避免硬撞限流。
  // 注意：必须用完整句式，且回复要"短"（纯限流提示才可能这么短），
  // 否则正常对话里夹带"限制/频繁"等词会被误判、进入长时间冷却导致看门狗不催。
  try {
    const RATE_KW = ['请求过于频繁', '请求次数过多', '您已达到', '达到使用限制', '今日使用次数',
      '请稍后再试', '请稍后重试', '服务器繁忙', '服务繁忙', '系统繁忙',
      'rate limit exceeded', 'too many requests', 'please try again later',
      'usage limit', 'quota exceeded'];
    const lower = text.toLowerCase();
    // 只有回复很短（<=300 字符）时，才可能是纯限流提示；长回复夹带这些词不算
    if (lower.length <= 300) {
      for (const kw of RATE_KW) {
        if (lower.indexOf(kw) !== -1) {
          console.log('[TokFree] 检测到限流提示[' + kw + ']，进入冷却');
          if (window.electronAPI && window.electronAPI.noteRateLimit) {
            window.electronAPI.noteRateLimit(kw).catch(() => {});
          }
          break;
        }
      }
    }
  } catch (_) {}

  // 【AI 协作】Worker 任务模式：仅当回复含同步暗号时才回传主大脑（阶段完成/需决策）；
  // 不含暗号则视为次大脑继续执行，落到下方照常执行 tokfree 代码块。
  const __rptHas = (s, e) => text.indexOf(s) !== -1 && text.indexOf(e) !== -1;
  const __rptIsDone = __rptHas('>>>MASTER_DONE_START<<<', '>>>MASTER_DONE_END<<<');
  const __rptIsReport = __rptIsDone || __rptHas('>>>MASTER_ASK_START<<<', '>>>MASTER_ASK_END<<<') || __rptHas('>>>MASTER_SYNC_START<<<', '>>>MASTER_SYNC_END<<<');
  if (state.currentWorkerTaskId && __rptIsReport) {
    console.log('[TokFree] 拦截到 Worker 任务回复 (DOM模式)，直接上报, taskId=' + state.currentWorkerTaskId);
    try { window.electronAPI.reportAiResponse(text, state.currentWorkerTaskId).catch(() => {}); } catch (e) {}
    if (__rptIsDone) { state.workerDoneReported = true; state.currentWorkerTaskId = null; }
    if (!force) processedMessages.add(lastMessage);
    wdProgress();
    return;
  }

  // 是否为疑似工具内容（用于控制详细日志与提示文案）
  const looksToolish = text.includes(FENCE) ||
    /toolName|"tool"|file_|await\s+(?:read|write|edit|glob|grep|bash|pwsh|todoWrite|deleteFile|webFetch|openBrowserWindow|injectJS|readFile|writeFile|editFile)\s*\(/.test(text);

  // 长度必打；原文/转义仅在疑似工具内容时打印（普通聊天回复不再刷屏）
  console.log('[TokFree] 回复文本长度: ' + text.length + (looksToolish ? '（疑似工具内容）' : '（普通文本）'));
  if (looksToolish) {
    console.log('[TokFree] 回复完整内容(原文):');
    console.log(text);
    console.log('[TokFree] 回复完整内容(转义显示):');
    console.log(JSON.stringify(text));
  }

  // 内容不完整（疑似流式输出未真正结束）：延迟重试，避免处理截断的 JSON
  if (!force && !isJsonBalanced(text)) {
    if (retryCount < MAX_RETRY_COUNT) {
      console.log('[TokFree] ⏳ JSON 不完整(疑似流式未结束)，' + (retryCount + 1) + '/' + MAX_RETRY_COUNT + ' 次延迟重试, 当前长度=' + text.length + '...');
      setTimeout(() => processLatestAIResponse(retryCount + 1), RETRY_INTERVAL);
      return; // 不标记 processed，允许重试
    }
    console.log('[TokFree] ⚠️ JSON 持续不完整（20次重试仍截断），放弃本次处理，当前长度=' + text.length);
    // 回传 AI，让它重新完整输出
    sendToolResultToChat(
      { toolName: '未知', callId: 'incomplete' },
      { success: false, error: '收到不完整的工具调用 JSON（内容被截断），请重新完整输出工具调用。' }
    );
  }

  if (!force) processedMessages.add(lastMessage);



  const toolCall = tryParseToolCall(text);
  if (toolCall) {
    // 正确使用 JSON 工具调用，重置 XML 提示计数
    xmlHintCount = 0;
    // 验证 toolName 是否在工具库中
    const available = hasTool(toolCall.toolName);
    if (!available) {
      console.log('[TokFree] ⚠️ 工具不存在: ' + toolCall.toolName + ', 可用工具: ' + toolNamesList());
      // 回传 AI，告知工具不存在
      sendToolResultToChat(
        toolCall,
        { success: false, error: '工具 ' + toolCall.toolName + ' 不存在，可用工具: ' + toolNamesList() }
      );
      return;
    }
    console.log('[TokFree] ✅ 工具存在: ' + toolCall.toolName + ', 开始执行');
    notifyToolCallDetected(toolCall);
    handleToolCall(toolCall);
    wdProgress();
    return true;
  } else {
    // JSON 工具调用未解析到，再检测 XML 格式的工具调用
    // 诊断：打印 XML 检测相关状态（text 和 innerHTML）
    console.log('[TokFree] [XML诊断] text长度=' + text.length + ', 开头100字符=' + JSON.stringify(text.slice(0, 100)));
    console.log('[TokFree] [XML诊断] markdown.innerHTML长度=' + (markdown.innerHTML || '').length + ', 开头200字符=' + JSON.stringify((markdown.innerHTML || '').slice(0, 200)));
    console.log('[TokFree] [XML诊断] 是否有 pre code 元素=' + !!markdown.querySelector('pre code'));
    // 精准判断：
    // 1. <｜｜DSML｜｜ 开头直接触发（自定义标签前缀，如 <｜｜DSML｜｜tool_calls>、<｜｜DSML｜｜invoke>）
    // 2. <invoke 必须带 name 属性，且出现闭合标签或 parameter 参数标签
    const hasAntmlXml = /^<\s*｜｜DSML｜｜/i.test(text);
    const hasXmlInvoke = /<\s*(?:[\w-]+:)?invoke\s+name=/i.test(text);
    const hasXmlClose = /<\s*\/\s*(?:[\w-]+:)?invoke\s*>/i.test(text);
    const hasXmlParam = /<\s*(?:[\w-]+:)?parameter\s+name=/i.test(text);
    if (hasAntmlXml || (hasXmlInvoke && (hasXmlClose || hasXmlParam))) {
      // 防止同一条消息被反复扫描时重复发送提示语
      if (!force) processedMessages.add(lastMessage);

      if (xmlHintCount >= XML_HINT_MAX) {
        // 已连续提示多次，AI 仍用 XML 格式，熔断停止发送，避免无限循环
        console.log('[TokFree] ⚠️ 已连续提示 ' + xmlHintCount + ' 次 XML 格式，停止发送提示语');
        return;
      }
      xmlHintCount++;
      console.log('[TokFree] ⚠️ 检测到 XML 格式工具调用（第 ' + xmlHintCount + ' 次提示），提示 AI 改用 tokfree 代码块');
      const BT = String.fromCharCode(96);
      sendMessageToChat(
        '请使用' + BT + BT + BT + 'tokfree' + BT + BT + BT + ' 代码块进行工具调用，不要使用 XML invoke 格式。',
        'XML工具调用提示'
      );
      wdProgress();
      return;
    }

    if (looksToolish) {
      // 疑似工具内容但 JS 块检测与 JSON 解析都没命中 → 打印诊断，帮助定位
      console.log('[TokFree] ⚠️ 回复疑似工具调用但未被识别（JS 代码块未匹配 / JSON 解析失败）');
      const pres = markdown.querySelectorAll('pre');
      if (pres.length > 0) {
        for (const p of pres) {
          const providerForLang = getCurrentProvider();
          const lang = (providerForLang && typeof providerForLang.getCodeBlockLanguage === 'function')
            ? providerForLang.getCodeBlockLanguage(p)
            : '';
          console.log('[TokFree] [诊断] 代码块 language=' + (lang || '(无)') + ', 内容前80字符=' + ((p.textContent || '').trim().slice(0, 80)));
        }
      } else {
        console.log('[TokFree] [诊断] 消息中没有任何 pre 代码块');
      }
    } else {
      console.log('[TokFree] ℹ️ 正常文本回复，未检测到工具调用（无需处理）');
      // 防重复：同一文本不重复通知（完成检测轮询每 2s 触发一次，避免刷屏）
      if (lastNotifiedText !== text) {
        lastNotifiedText = text;
        try { if (localStorage.getItem('tokfree-notify-enabled') !== '0') window.electronAPI.showAiNotification().catch(() => {}); } catch (_) { window.electronAPI.showAiNotification().catch(() => {}); }
      }
      // 看门狗（方案 B）：纯文本回复 → 进入完成确认模式。
      // 若文本含代码围栏（仍有产出），视为进展不催促。
      const BTc = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96);
      if (text.indexOf(BTc) !== -1) {
        wdProgress();
      } else {
        wdConfirm(text);
      }
    }
  }
}
// 读取防抖定时器（已弃用，改用 Promise sleep + 处理中标志位）
let isProcessingResponse = false;
let lastObserverRun = 0;
let completionPollTimer = null;
let lastNotifiedText = '';
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function startObserver() {
  const observer = new MutationObserver((mutations) => {
    // 100ms 节流：避免页面高频 DOM 变化导致日志与检测刷屏
    const now = Date.now();
    if (now - lastObserverRun < 100) return;
    lastObserverRun = now;

    let hasNewContent = false;
    const mutationStats = { childList: 0, characterData: 0, attributes: 0 };
    for (const mutation of mutations) {
      mutationStats[mutation.type] = (mutationStats[mutation.type] || 0) + 1;
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        // 扫描命令
        const commands = scanForCommands(mutation.addedNodes);
        for (const cmd of commands) {
          displayCommand({ command: cmd, timestamp: Date.now(), id: generateId() });
        }
        hasNewContent = true;
      } else if (mutation.type === 'characterData' || mutation.type === 'attributes') {
        // Claude 的完成信号（retry 按钮 / 代码块）可能通过文本或属性变化出现，
        // 不产生新增子节点，也需要触发完成检测。
        hasNewContent = true;
      }
    }

    // 回复结束后读取最新 AI 回复；完成判定内部已含必要等待
    if (hasNewContent && !isProcessingResponse) {
      // 若最后一条 AI 消息已处理过，则跳过，避免反复打印和等待
      const candidates = getMessageCandidates();
      const lastMsg = candidates.length > 0 ? candidates[candidates.length - 1] : null;
      if (lastMsg && processedMessages.has(lastMsg)) {
        return;
      }

      isProcessingResponse = true;
      (async () => {
        try {
          if (await isAIResponseComplete()) {
            processLatestAIResponse();
          }
        } finally {
          isProcessingResponse = false;
        }
      })();
    }
  });

  const target = document.body || document.documentElement;
  if (target) {
    observer.observe(target, { childList: true, subtree: true, characterData: true, attributes: true });
  }

  // 完成检测兜底轮询：mutation 通道存在漏触发窗口——
  // 长回复期间"停止对话"按钮常驻使 isAIResponseComplete 持续 false，生成结束按钮消失
  // 这一完成信号若恰好落在 100ms 节流 / isProcessingResponse 串行窗口内会被丢弃，
  // 之后无新 DOM 变化则永久不触发。定期主动复查一次，覆盖长生成场景。
  if (!completionPollTimer) {
    completionPollTimer = setInterval(() => {
      if (isProcessingResponse) return;
      (async () => {
        try {
          if (await isAIResponseComplete()) {
            processLatestAIResponse();
          }
        } catch (_) { /* 轮询失败静默，等待下一轮 */ }
      })();
    }, 2000);
  }
}


/**
 * 通知用户检测到工具调用（闪烁状态徽章 + 展开覆盖层）
 */
function notifyToolCallDetected(toolCall) {
  // 方向 C：不强制弹面板，只更新预览和徽章
  // 更新预览区域显示检测到的工具调用
  const preview = document.getElementById('tokfree-cmd-preview');
  if (preview) {
    preview.textContent = `[工具] ${toolCall.toolName}\n参数: ${JSON.stringify(toolCall.params, null, 2)}`;
  }
  // 闪烁状态徽章
  flashBadge('TokFree - 工具调用检测到');
}
/**
 * 通知用户检测到 JS 工具脚本（更新预览 + 闪烁徽章）
 */
function notifyJsScriptDetected(code) {
  // 方向 C：不强制弹面板
  const preview = document.getElementById('tokfree-cmd-preview');
  if (preview) {
    preview.textContent = '[JS 工具脚本]' + String.fromCharCode(10) + code;
  }
  flashBadge('TokFree - JS 工具脚本检测到');
}
/**
 * 执行检测到的 JS 工具脚本（带双通道去重）
 */
async function handleJsToolScript(code) {
  // 方向 C：不强制弹面板
  isExecuting = true;
  notifyJsScriptDetected(code);
  setTaskStatus(true);
  showToast('开始执行命令');

  const callId = 'js_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  console.log('[TokFree] [诊断] 即将执行的代码(JSON转义): ' + JSON.stringify(code));
  try {
    const result = await window.electronAPI.executeJs(code, callId);

    const resultSection = document.getElementById('tokfree-result-section');
    const resultStatus = document.getElementById('tokfree-result-status');
    const resultOutput = document.getElementById('tokfree-result-output');
    if (resultSection) resultSection.classList.remove('tokfree-hidden');

    if (result.success) {
      if (resultStatus) {
        resultStatus.textContent = '✅ JS 脚本执行成功';
        resultStatus.className = 'tokfree-result-status success';
      }
      if (resultOutput) {
        resultOutput.textContent = result.output || '(脚本执行完成，无输出)';
      }
    } else {
      if (resultStatus) {
        resultStatus.textContent = '❌ JS 脚本执行失败';
        resultStatus.className = 'tokfree-result-status error';
      }
      if (resultOutput) {
        resultOutput.textContent = result.error || '未知错误';
      }
    }

    addHistory({
      id: callId,
      command: '[JS] ' + truncate((code.split(String.fromCharCode(10))[0] || code), 60),
      success: result.success,
      output: result.success ? (result.output || '') : (result.error || '未知错误'),
      timestamp: Date.now(),
    });

    // 返回执行结果，由调用方统一合并回传
    return { code, result };
  } catch (err) {
    console.error('[TokFree] JS 工具脚本执行异常:', err);
    const resultSection = document.getElementById('tokfree-result-section');
    const resultStatus = document.getElementById('tokfree-result-status');
    const resultOutput = document.getElementById('tokfree-result-output');
    if (resultSection) resultSection.classList.remove('tokfree-hidden');
    if (resultStatus) {
      resultStatus.textContent = '❌ 系统错误';
      resultStatus.className = 'tokfree-result-status error';
    }
    if (resultOutput) {
      resultOutput.textContent = err.message || String(err);
    }
    return { code, result: { success: false, error: '系统异常: ' + (err.message || String(err)) } };
  } finally {
    isExecuting = false;
    setTaskStatus(false);
  }
}
/**
 * 执行工具调用
 */
async function handleToolCall(toolCall) {
  const { toolName, params, callId } = toolCall;
  console.log(`[TokFree] 执行工具: ${toolName}`, params);

  // 方向 C：不强制弹面板
  isExecuting = true;
  setTaskStatus(true);
  showToast('开始执行命令');

  try {
    const result = await window.electronAPI.executeTool(toolName, params, callId);

    // 显示执行结果
    const resultSection = document.getElementById('tokfree-result-section');
    const resultStatus = document.getElementById('tokfree-result-status');
    const resultOutput = document.getElementById('tokfree-result-output');

    if (resultSection) resultSection.classList.remove('tokfree-hidden');

    if (result.success) {
      if (resultStatus) {
        resultStatus.textContent = `✅ 工具 ${toolName} 执行成功`;
        resultStatus.className = 'tokfree-result-status success';
      }
      if (resultOutput) {
        resultOutput.textContent = JSON.stringify(result.data, null, 2);
      }
    } else {
      if (resultStatus) {
        resultStatus.textContent = `❌ 工具 ${toolName} 执行失败`;
        resultStatus.className = 'tokfree-result-status error';
      }
      if (resultOutput) {
        resultOutput.textContent = result.error || '未知错误';
      }
    }

    // 添加到历史
    addHistory({
      id: callId,
      command: `[工具] ${toolName}`,
      success: result.success,
      output: result.success ? JSON.stringify(result.data, null, 2) : (result.error || '未知错误'),
      timestamp: Date.now(),
    });

    // 将执行结果发送回聊天，让 AI 看到结果并继续工作
    sendToolResultToChat(toolCall, result);
  } catch (err) {
    console.error('[TokFree] 工具执行异常:', err);
    const resultSection = document.getElementById('tokfree-result-section');
    const resultStatus = document.getElementById('tokfree-result-status');
    const resultOutput = document.getElementById('tokfree-result-output');
    if (resultSection) resultSection.classList.remove('tokfree-hidden');
    if (resultStatus) {
      resultStatus.textContent = '❌ 系统错误';
      resultStatus.className = 'tokfree-result-status error';
    }
    if (resultOutput) resultOutput.textContent = err.message || String(err);
    // 系统异常也要回传 AI，让它知道发生了什么
    sendToolResultToChat(toolCall, { success: false, error: '系统异常: ' + (err.message || String(err)) });
  } finally {
    isExecuting = false;
    setTaskStatus(false);
  }
}

module.exports = {
  processLatestAIResponse,
  startObserver,
  notifyToolCallDetected,
  notifyJsScriptDetected,
  handleJsToolScript,
  handleToolCall,
  handleManualParse,
};
