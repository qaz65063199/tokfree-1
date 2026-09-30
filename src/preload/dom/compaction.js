/**
 * 上下文压缩：全自动流程（纯 API，不依赖 DOM 点击）
 *
 * 流程：
 *  0. 记录压缩前的 session_id 与最大 message_id
 *  1. 发送"自摘要"指令，让 AI 生成结构化交接摘要，等待回复完成
 *  2. 从 URL 获取 chat_session_id
 *  3. 从 IndexedDB 读取全量 message_ids
 *  4. 取尾部 20%（保证 USER/ASSISTANT 成对）+ 补入摘要消息 id
 *  5. 用缓存的真实请求头直接 fetch /api/v0/share/create
 *  6. 得到 share_id → 拼分享链接
 *  7. 跳转 → 新页面检测到待初始化标记，自动初始化项目并续接
 *
 * 依赖：
 *  - hook 已把真实请求头缓存到 localStorage['tokfree-ds-headers']
 *  - DeepSeek 把会话消息缓存在 IndexedDB 'deepseek-chat' 的 'history-message' store
 */
const { sendToChat } = require('./chat-input');
const { onInterceptedResponse } = require('./intercept-observer');
const { showToast } = require('../overlay/ui');
const state = require('./state');
const { getProviderByUrl } = require('../../../src/providers');
const dialog = require('../overlay/dialog');

// 自摘要指令：生成结构化"交接摘要"，供新会话据此补全上下文并继续工作
const SUMMARY_INSTRUCTION = [
  '请对以上整段对话做一次「上下文交接摘要」，用于在另一个新会话中无缝继续本项工作。',
  '要求：',
  '1. 完整保留关键信息：任务目标、背景上下文、已完成的结论、做出的关键决策及原因。',
  '2. 明确列出当前状态与未完成事项（待办清单）。',
  '3. 列出后续工作需要重点关注的文件、目录、命令或资料（尽量给出真实路径/名称）。',
  '4. 用中文，一次性输出全部内容，直接输出摘要，不要输出其他解释。',
].join('\n');

/** 日志前缀 */
function logStep(step, msg) {
  console.log('[TokFree Compact] [' + step + '] ' + msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等待 AI 回复完成（拦截到完整回复） */
function waitForResponse(timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const off = onInterceptedResponse((text) => {
      if (done) return;
      done = true;
      off();
      clearTimeout(timer);
      resolve(text);
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      off();
      reject(new Error('等待 AI 回复超时（' + timeoutMs + 'ms）'));
    }, timeoutMs);
  });
}

/** 从当前 URL 获取 chat_session_id */
function getSessionIdFromUrl() {
  const m = String(location.href).match(/\/chat\/s\/([a-f0-9-]+)/i);
  return m ? m[1] : null;
}

/** 从 localStorage 读取缓存的真实请求头 */
function getCachedHeaders() {
  try {
    const raw = localStorage.getItem('tokfree-ds-headers');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * 从 IndexedDB 读取指定会话的全量消息（含 role），按 message_id 升序
 */
function getMessagesFromIndexedDB(sessionId) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open('deepseek-chat'); } catch (e) { reject(e); return; }
    req.onerror = () => reject(new Error('打开 IndexedDB 失败'));
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('history-message', 'readonly');
        const store = tx.objectStore('history-message');
        const g = store.get(sessionId);
        g.onsuccess = () => {
          db.close();
          const val = g.result;
          const msgs = val && val.data && val.data.chat_messages;
          if (!Array.isArray(msgs)) { reject(new Error('IndexedDB 无该会话消息')); return; }
          const list = msgs
            .filter((m) => typeof m.message_id === 'number')
            .map((m) => ({ message_id: m.message_id, role: m.role || '', parent_id: m.parent_id }))
            .sort((a, b) => a.message_id - b.message_id);
          resolve(list);
        };
        g.onerror = () => { db.close(); reject(new Error('读取消息失败')); };
      } catch (e) { db.close(); reject(e); }
    };
  });
}

/** 读取某会话在 IndexedDB 中的最大 message_id（无则返回 0） */
async function getMaxMessageId(sessionId) {
  try {
    const msgs = await getMessagesFromIndexedDB(sessionId);
    if (!msgs.length) return 0;
    return msgs[msgs.length - 1].message_id;
  } catch (_) {
    return 0;
  }
}

/**
 * 从消息列表中取最近 ratio 比例的消息，保证成对（USER + ASSISTANT）
 * DeepSeek 要求 share/create 的 message_ids 必须成对出现。
 */
function pickRecentPairedIds(msgs, ratio) {
  const total = msgs.length;
  if (total === 0) return [];
  let keep = Math.max(2, Math.round(total * ratio));
  let start = Math.max(0, total - keep);
  while (start > 0 && msgs[start].role !== 'USER') start--;
  let end = total;
  while (end > start + 1 && msgs[end - 1].role !== 'ASSISTANT') end--;
  const picked = msgs.slice(start, end);
  // DeepSeek 要求 message_ids 降序（最新在前）
  return picked.map((m) => m.message_id).sort((a, b) => b - a);
}

/**
 * 调用 share/create 创建分享
 */
async function createShare(sessionId, messageIds, headers) {
  const h = Object.assign({}, headers);
  h['content-type'] = 'application/json';
  const resp = await fetch('/api/v0/share/create', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ chat_session_id: sessionId, message_ids: messageIds }),
  });
  const txt = await resp.text();
  console.log('[TokFree Compact] [api] share/create HTTP ' + resp.status + ' 响应: ' + txt.slice(0, 600));
  let json = null;
  try { json = JSON.parse(txt); } catch (_) {}
  if (!json || json.code !== 0) {
    throw new Error('创建分享失败: ' + (json ? json.msg : txt.slice(0, 200)));
  }
  const shareId = json.data && json.data.biz_data && json.data.biz_data.share_id;
  if (!shareId) throw new Error('响应无 share_id（完整响应见日志）');
  return shareId;
}

/** 获取当前页面所属 provider（用于压缩能力判定） */
function getCurrentProvider() {
  try { return getProviderByUrl(window.location.href); } catch (_) { return null; }
}

/**
 * 压缩入口：按 provider 能力分派。
 * - supportsFullCompaction=true（DeepSeek）：原全自动流程（IndexedDB + share，跳转新会话续接）
 * - 其余 provider：通用压缩（生成交接摘要 → 复制剪贴板 → 引导用户新建会话粘贴）
 */
async function runCompaction() {
  const provider = getCurrentProvider();
  if (provider && provider.supportsFullCompaction) {
    return runDeepSeekCompaction();
  }
  return runGenericCompaction(provider);
}

/**
 * 通用压缩（非 DeepSeek 平台的优雅降级）：
 * 在当前会话让 AI 生成结构化交接摘要，复制到剪贴板，引导用户新建会话后粘贴继续。
 * 不依赖任何平台特有 API（IndexedDB / share）。
 */
async function runGenericCompaction(provider) {
  const btn = document.getElementById('tokfree-btn-compact');
  const name = (provider && provider.name) || '当前平台';
  const ok = await dialog.confirm(
    name + ' 暂不支持「全自动压缩」（自动新建会话并续接）。\n\n' +
    '将改用通用方案：在当前会话生成一份「交接摘要」并复制到剪贴板，' +
    '由你新建会话后粘贴继续。\n\n是否继续？',
    { title: '通用上下文压缩', okText: '生成摘要', cancelText: '取消' }
  );
  if (!ok) return;
  if (btn) { btn.disabled = true; btn.textContent = '压缩中...'; }

  // 压缩期间暂停「失败自动重试」和「工具循环看门狗」，避免污染摘要请求 / 误催
  try { require('./retry-engine').setCompacting(true); } catch (_) {}
  try { require('./tool-loop-watchdog').setSuspended(true); } catch (_) {}

  try {
    state.lastResponseMsgIds = null;
    logStep('generic', '发送自摘要指令');
    const waitReply = waitForGenericResponse(provider, 180000);
    sendToChat(SUMMARY_INSTRUCTION, '压缩-摘要', 300);
    const summaryText = await waitReply;
    if (!summaryText || !summaryText.trim()) throw new Error('未获取到摘要内容');
    logStep('generic', '收到摘要，长度=' + summaryText.length);

    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(summaryText);
        copied = true;
      }
    } catch (_) {}

    await dialog.alert(
      (copied ? '✅ 摘要已复制到剪贴板。\n\n' : '⚠️ 自动复制失败，请手动复制下方摘要。\n\n') +
      '下一步：点击「新对话」新建会话，把摘要粘贴进去发送，即可继续本项工作。\n\n' +
      '————————\n' + summaryText,
      { title: '压缩完成', okText: '知道了' }
    );
  } catch (err) {
    console.error('[TokFree Compact] 通用压缩失败:', err);
    showToast('压缩失败: ' + err.message, 5000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '压缩'; }
    try { require('./retry-engine').setCompacting(false); } catch (_) {}
    try { require('./tool-loop-watchdog').setSuspended(false); } catch (_) {}
  }
}

/** 读取最后一条 AI 回复的纯文本（DOM 模式兜底） */
function readLastAssistantText(provider) {
  try {
    const cands = typeof provider.getMessageCandidates === 'function' ? provider.getMessageCandidates() : [];
    const last = cands[cands.length - 1];
    if (!last) return '';
    const md = typeof provider.getMessageMarkdown === 'function' ? provider.getMessageMarkdown(last) : null;
    return (((md || last).textContent) || '').trim();
  } catch (_) { return ''; }
}

/**
 * 等待一次完整 AI 回复（通用）。
 * - 拦截模式（useIntercept）：复用 onInterceptedResponse 事件
 * - DOM 模式：轮询 provider.isGenerating / isResponseComplete，完成后读最后一条消息
 */
function waitForGenericResponse(provider, timeoutMs) {
  if (provider && provider.useIntercept) {
    return waitForResponse(timeoutMs);
  }
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let sawGenerating = false;
    const timer = setInterval(() => {
      try {
        const generating = typeof provider.isGenerating === 'function' && provider.isGenerating();
        if (generating) sawGenerating = true;
        const complete = typeof provider.isResponseComplete === 'function' && provider.isResponseComplete();
        // 需先观察到生成态，或超过 3s 宽限期，避免瞬时误判
        if (complete && (sawGenerating || Date.now() - start > 3000)) {
          clearInterval(timer);
          resolve(readLastAssistantText(provider));
          return;
        }
      } catch (_) {}
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error('等待 AI 回复超时（' + timeoutMs + 'ms）'));
      }
    }, 1000);
  });
}

/** 原 DeepSeek 全自动压缩流程（IndexedDB + share API，跳转新会话续接） */
async function runDeepSeekCompaction() {
  const btn = document.getElementById('tokfree-btn-compact');
  if (btn) { btn.disabled = true; btn.textContent = '压缩中...'; }

  // 压缩期间暂停「失败自动重试」和「工具循环看门狗」，避免污染摘要请求 / 误催
  try { require('./retry-engine').setCompacting(true); } catch (_) {}
  try { require('./tool-loop-watchdog').setSuspended(true); } catch (_) {}

  try {
    // 步骤 0：先取 session_id
    const sessionId = getSessionIdFromUrl();
    if (!sessionId) throw new Error('无法从 URL 获取 chat_session_id');
    logStep('api', 'chat_session_id = ' + sessionId);
    const maxIdBefore = await getMaxMessageId(sessionId);
    logStep('summary', '发送前 maxMessageId=' + maxIdBefore);

    // 步骤 1：让 AI 写「交接摘要」
    state.lastResponseMsgIds = null; // 清空，避免拿到上一条
    logStep('summary', '发送自摘要指令');
    const waitReply = waitForResponse(120000);
    sendToChat(SUMMARY_INSTRUCTION, '压缩-摘要', 300);
    const summaryText = await waitReply;
    logStep('summary', '收到摘要回复，长度=' + (summaryText || '').length);

    // 摘要回复的 id（来自 SSE 流，最准确）
    const summaryIds = state.lastResponseMsgIds;
    const summaryRespId = summaryIds && summaryIds.responseMessageId;
    const summaryReqId = summaryIds && summaryIds.requestMessageId;
    logStep('summary', '摘要消息 id: response=' + (summaryRespId || '?') + ' request=' + ((summaryIds && summaryIds.requestMessageId) || '?'));

    await sleep(500);

    // 步骤 3：取请求头
    const headers = getCachedHeaders();
    if (!headers || !headers['authorization']) {
      throw new Error('未获取到认证请求头（请刷新页面后重试）');
    }
    logStep('api', '已获取缓存的请求头');

    // 步骤 4：读 IndexedDB 拿全量消息，取最近 20% 且保证成对
    const allMsgs = await getMessagesFromIndexedDB(sessionId);
    if (allMsgs.length === 0) throw new Error('未读取到消息列表');
    let tailIds = pickRecentPairedIds(allMsgs, 0.2);
    if (tailIds.length === 0) throw new Error('裁剪后无有效消息');

    // 补入摘要消息
    if (typeof summaryRespId === 'number') {
      const idSet = new Set(tailIds);
      const extra = [];
      if (!idSet.has(summaryRespId)) extra.push(summaryRespId);
      if (typeof summaryReqId === 'number' && !idSet.has(summaryReqId)) extra.push(summaryReqId);
      if (extra.length) {
        tailIds = tailIds.concat(extra).sort((a, b) => b - a);
        logStep('api', '补入摘要消息 id: ' + JSON.stringify(extra));
      }
    }

    logStep('api', '全量消息 ' + allMsgs.length + ' 条，保留最近 ' + tailIds.length + ' 条（成对）');

    // 步骤 5：直接调 share/create
    const shareId = await createShare(sessionId, tailIds, headers);
    const link = 'https://chat.deepseek.com/share/' + shareId;
    logStep('api', '分享链接: ' + link);

    // 步骤 6：跳转（存标记 + 项目目录）
    showToast('压缩完成，正在打开新会话...', 3000);
    try {
      localStorage.setItem('tokfree-compact-pending-init', String(Date.now()));
      if (state.currentProjectDir) {
        localStorage.setItem('tokfree-compact-project-dir', state.currentProjectDir);
      }
    } catch (_) {}
    window.location.href = link;

  } catch (err) {
    console.error('[TokFree Compact] 压缩失败:', err);
    showToast('压缩失败: ' + err.message, 5000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '压缩'; }
    // 恢复重试引擎与看门狗
    try { require('./retry-engine').setCompacting(false); } catch (_) {}
    try { require('./tool-loop-watchdog').setSuspended(false); } catch (_) {}
  }
}

/**
 * 页面加载后检查是否有待执行的"压缩后初始化"
 */
function checkPendingInit() {
  let pending = null;
  let projectDir = null;
  try {
    pending = localStorage.getItem('tokfree-compact-pending-init');
    projectDir = localStorage.getItem('tokfree-compact-project-dir');
  } catch (_) {}
  if (!pending) return;
  try {
    localStorage.removeItem('tokfree-compact-pending-init');
    localStorage.removeItem('tokfree-compact-project-dir');
  } catch (_) {}
  console.log('[TokFree Compact] 检测到压缩后待初始化，3 秒后执行；项目目录=' + (projectDir || '(无)'));
  setTimeout(() => {
    try {
      window.electronAPI.initProject(projectDir || null, true);
    } catch (err) {
      console.error('[TokFree Compact] 压缩后初始化失败:', err);
    }
  }, 3000);
}

module.exports = { runCompaction, checkPendingInit };

