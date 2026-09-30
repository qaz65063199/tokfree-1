/**
 * 会话内容提取（供壳层 Agent 视图渲染）
 *
 * 从当前页面 DOM 提取结构化对话模型：
 *   - 用户消息（文字）/ 工具回执（receipt）
 *   - AI 消息：叙述 HTML（剔除 tokfree 工具代码块）、思考块、工具步骤摘要
 *
 * 只读操作，不改动页面任何东西。与 hide-tool-turn（显示层隐藏）互补：
 * 本模块负责「取数」，壳层负责「以 Agent 风格重新呈现」。
 */
const { getProviderByUrl } = require('../../../src/providers');

// 工具回执消息特征前缀（与 hide-tool-turn 保持一致）
const RECEIPT_PREFIXES = [
  '【JS 执行结果汇总】',
  '【工具执行结果】',
];

// 初始化提示词零宽标记（与 chat-input.js 发送时追加的一致，从 localStorage 读取）
const INIT_MARKER_DEFAULT = '\u200B\u2063\u200B';
function getInitMarker() {
  try {
    return localStorage.getItem('tokfree-init-marker') || INIT_MARKER_DEFAULT;
  } catch (_) { return INIT_MARKER_DEFAULT; }
}

/** 判断用户消息文本是否为「初始化提示词」（含零宽标记）→ 提取时直接跳过 */
function isInitPromptText(text) {
  if (!text) return false;
  try {
    return String(text).indexOf(getInitMarker()) !== -1;
  } catch (_) { return false; }
}

// DeepSeek「思考过程」标题文本特征（与 hide-tool-turn 保持一致）
const THINK_HEADER_RE = /^(已深度思考|深度思考（|深度思考$|DeepSeek 思考了|Thought for \d+|Thinking\b)/;

// 工具名 → 步骤简述（未收录的工具名原样展示）
const TOOL_LABELS = {
  read: '读取文件', readLines: '读取文件', write: '写入文件', edit: '编辑文件',
  deleteFile: '删除文件', glob: '查找文件', grep: '搜索内容',
  bash: '运行命令', pwsh: '运行命令', webFetch: '抓取网页', mysql: '查询数据库',
  todoWrite: '更新任务清单',
  mcpCall: '调用 MCP 工具', mcpListServers: '查看 MCP 服务', mcpGetTools: '查看 MCP 工具',
  openBrowserWindow: '打开浏览器窗口', injectJS: '注入脚本',
  human_move: '模拟鼠标移动', human_click: '模拟点击', human_type: '模拟输入', human_scroll: '模拟滚动',
  lesson_record: '记录经验教训', lesson_list: '列出经验教训', lesson_delete: '删除经验教训', lesson_search: '检索经验教训',
  skill_list: '列出技能', skill_read: '读取技能', skill_create: '创建技能', skill_update: '更新技能',
  skill_delete: '删除技能', skill_enable: '启用技能', skill_disable: '停用技能',
  preference_read: '读取偏好', preference_append: '追加偏好',
  team_list_workers: '列出子 Agent', team_get_workers_status: '查看子 Agent 状态',
  team_dispatch_task: '派发子任务', team_dispatch_batch: '批量派发子任务',
  team_get_progress: '查看任务进度', team_cancel_task: '取消子任务', team_get_task_status: '查看子任务状态',
  team_create_window: '创建子 Agent 窗口', team_read_inbox: '读取子 Agent 回报', team_reply_to_worker: '回复子 Agent',
  team_plan_create: '创建编排计划', team_plan_status: '查看编排计划', team_plan_clear: '清空编排计划',
  auto_trace_list: '查看演化轨迹', auto_retrospect: '任务复盘',
};
const TOOL_NAMES = new Set(Object.keys(TOOL_LABELS));

// 单条消息正文 HTML / 文本的体积上限（防止超长会话把 IPC 拖垮）
const MAX_HTML = 200 * 1024;
const MAX_TEXT = 4000;
const MAX_THINKING = 6000;
const MAX_STEPS_PER_MSG = 30;

/** 安全取 provider（任何异常都视为无 provider） */
function safeGetProvider() {
  try { return getProviderByUrl(window.location.href); } catch (_) { return null; }
}

/** 判断文本是否为工具回执消息（容忍前导空白/零宽字符，语义仍为“以回执前缀开头”） */
function isReceiptText(text) {
  if (!text) return false;
  // 网页 innerText 常带前导换行/空格/零宽字符，先剥离再判断前缀，避免回执漏识别
  const s = String(text).replace(/^[\s\u200b\u200c\u200d\ufeff]+/, '');
  for (const p of RECEIPT_PREFIXES) {
    if (s.indexOf(p) === 0) return true;
  }
  return false;
}

/**
 * 从 tokfree 工具脚本文本提取调用摘要。
 * 匹配 `工具名("第一个字符串参数"` 形式（单/双引号/反引号），
 * 只统计已知工具名，参数截断展示。
 * @param {string} code
 * @returns {Array<{name:string,label:string,arg:string}>}
 */
function summarizeToolCode(code) {
  const out = [];
  if (!code || typeof code !== 'string') return out;
  const re = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(\s*(['"`])((?:\\.|(?!\2)[\s\S]){0,200}?)\2/gm;
  let m;
  while ((m = re.exec(code)) !== null) {
    const name = m[1];
    if (!TOOL_NAMES.has(name)) continue;
    let arg = (m[3] || '').replace(/\s+/g, ' ').trim();
    if (arg.length > 60) arg = arg.slice(0, 60) + '…';
    out.push({ name: name, label: TOOL_LABELS[name] || name, arg: arg });
    if (out.length >= MAX_STEPS_PER_MSG) break;
  }
  return out;
}

// 各平台消息节点选择器（含 AI 与用户消息），与 hide-tool-turn.js 保持一致。
// 按顺序尝试：取第一个非空的选择器结果；同一选择器下做"最内层"过滤防嵌套误伤。
const MSG_SELECTORS = [
  '.ds-message',                        // DeepSeek（AI + 用户）
  '[data-message-author-role]',         // ChatGPT
  '[class*="message-row"]',             // Claude / 自定义
  '[class*="qwen-chat-message"]',       // Qwen
  '.answer',                            // 智谱 AI 回复
  '[class*="question"]',                // 智谱用户消息
  '[class*="message"]',                 // 通用兜底
];

/** 收集消息节点（多平台：按 MSG_SELECTORS 依次尝试，取第一个非空） */
function getMessageNodes() {
  let arr = [];
  for (const sel of MSG_SELECTORS) {
    let nodes;
    try { nodes = document.querySelectorAll(sel); } catch (_) { continue; }
    arr = Array.from(nodes);
    if (arr.length) break;
  }
  const inner = [];
  for (const n of arr) {
    let containsOther = false;
    for (const m of arr) {
      if (m !== n && n.contains(m)) { containsOther = true; break; }
    }
    if (!containsOther) inner.push(n);
  }
  return inner;
}

/** 判断消息节点是否用户消息（优先 provider，兜底结构启发式） */
function isUserMessage(node, provider) {
  try {
    if (provider && typeof provider.isUserMessage === 'function') {
      // 只有明确判定为 true 才返回；false 不直接下结论，继续走结构兜底
      if (provider.isUserMessage(node)) return true;
    }
  } catch (_) {}
  // DeepSeek 结构兜底：AI 消息的 .ds-message 内必有 .ds-markdown（答案容器），
  // 用户消息没有。DeepSeek 混淆类名/无 data-role，provider 判定常失效，故按此结构兜底。
  try {
    const cls = typeof node.className === 'string' ? node.className : '';
    if (cls.indexOf('ds-message') !== -1) {
      return !node.querySelector('.ds-markdown');
    }
  } catch (_) {}
  // 通用兜底（跨平台，不依赖 .ds-markdown）：
  // ① 显式角色属性（data-role/data-author/data-message-author-role）
  // ② 各平台用户消息类名
  try {
    let cur = node;
    while (cur) {
      const role = (cur.getAttribute && (cur.getAttribute('data-role') || cur.getAttribute('data-author') || cur.getAttribute('data-message-author-role'))) || '';
      if (role === 'user' || role === 'human') return true;
      const curCls = typeof cur.className === 'string' ? cur.className : '';
      if (curCls) {
        if (curCls.indexOf('qwen-chat-message-user') !== -1) return true;
        if (curCls.indexOf('message-row-user') !== -1) return true;
        if (curCls.indexOf('user-message') !== -1 || curCls.indexOf('message-user') !== -1) return true;
        if (curCls.indexOf('conversation') !== -1 && curCls.indexOf('question') !== -1) return true;
      }
      cur = cur.parentElement;
    }
  } catch (_) {}
  return false;
}

/** 在 AI 消息节点内找「思考过程」容器（复用 hide-tool-turn 的定位逻辑） */
function findThinkingContainers(msgNode) {
  const out = [];
  const seen = new Set();
  let descendants = [];
  try { descendants = msgNode.querySelectorAll('*'); } catch (_) { return out; }
  for (const el of descendants) {
    let t = '';
    try { t = (el.textContent || '').trim(); } catch (_) { continue; }
    if (!t || t.length > 60) continue;
    if (!THINK_HEADER_RE.test(t)) continue;
    let container = el;
    while (container.parentElement && container.parentElement !== msgNode) {
      container = container.parentElement;
    }
    if (container && container !== msgNode &&
        !(container.classList && container.classList.contains('ds-markdown')) &&
        !seen.has(container)) {
      seen.add(container);
      out.push({ header: t, container: container });
    }
  }
  return out;
}

/** 判断 pre 是否 tokfree 工具代码块（复用 provider 的语言识别 + data-language 兜底） */
function isTokfreePre(pre, provider) {
  let lang = '';
  try {
    if (provider && typeof provider.getCodeBlockLanguage === 'function') {
      lang = provider.getCodeBlockLanguage(pre) || '';
    }
  } catch (_) {}
  if (String(lang).toLowerCase() === 'tokfree') return true;
  try {
    let dl = pre.getAttribute('data-language') || '';
    if (!dl) {
      const holder = pre.closest && pre.closest('[data-language]');
      if (holder) dl = holder.getAttribute('data-language') || '';
    }
    if (String(dl).toLowerCase() === 'tokfree') return true;
  } catch (_) {}
  try {
    const code = pre.querySelector('code');
    const cls = code && typeof code.className === 'string' ? code.className : '';
    if (cls.toLowerCase().indexOf('tokfree') !== -1) return true;
  } catch (_) {}
  return false;
}

/** 提取 AI 消息：叙述 HTML（剔除 tokfree 代码块）+ 思考块 + 工具步骤 */
function extractAiMessage(node, provider) {
  // 思考块
  const thinking = [];
  try {
    for (const item of findThinkingContainers(node)) {
      let text = '';
      try { text = (item.container.innerText || item.container.textContent || '').trim(); } catch (_) {}
      // 去掉标题行，只留思考正文
      if (text.indexOf(item.header) === 0) text = text.slice(item.header.length).trim();
      if (text.length > MAX_THINKING) text = text.slice(0, MAX_THINKING) + '\n…[思考过长已截断]';
      if (text) thinking.push({ header: item.header, text: text });
    }
  } catch (_) {}

  // 工具步骤 + 叙述 HTML
  const steps = [];
  let html = '';
  let text = '';
  // 回复内容根节点：优先 provider，其次 DeepSeek，再次通用 markdown 容器，最后整节点
  let md = null;
  try {
    if (provider && typeof provider.getMessageMarkdown === 'function') {
      md = provider.getMessageMarkdown(node);
    }
  } catch (_) {}
  if (!md) {
    md = node.querySelector(':scope > .ds-markdown') || node.querySelector('.ds-markdown')
      || node.querySelector('[class*="markdown"]') || node.querySelector('[class*="md-body"]')
      || node;
  }
  try {
    const pres = node.querySelectorAll('pre');
    for (const pre of pres) {
      if (!isTokfreePre(pre, provider)) continue;
      const codeText = (pre.textContent || '') + '';
      const calls = summarizeToolCode(codeText);
      for (const c of calls) {
        steps.push(c);
        if (steps.length >= MAX_STEPS_PER_MSG) break;
      }
      if (steps.length >= MAX_STEPS_PER_MSG) break;
    }
  } catch (_) {}

  if (md) {
    try {
      const clone = md.cloneNode(true);
      const pres = clone.querySelectorAll('pre');
      for (const pre of pres) {
        if (!isTokfreePre(pre, provider)) continue;
        const block = (pre.closest && pre.closest('.md-code-block')) || pre;
        if (block && block.parentNode) block.parentNode.removeChild(block);
      }
      html = clone.innerHTML || '';
      if (html.length > MAX_HTML) html = html.slice(0, MAX_HTML);
      text = (clone.innerText || clone.textContent || '').trim();
      if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    } catch (_) {}
  }
  if (!text) {
    try { text = (node.innerText || node.textContent || '').trim().slice(0, MAX_TEXT); } catch (_) {}
  }
  return { role: 'ai', kind: 'message', html: html, text: text, thinking: thinking, steps: steps };
}

/**
 * 从用户消息文本中剔除 tokfree 工具代码块（三反引号 tokfree ... 三反引号），
 * 折叠为占位符「（已执行工具调用）」。用户只应看到自然语言意图，
 * 不应看到又长又占空间的工具调用回执。
 * @param {string} text
 * @returns {string}
 */
function stripTokfreeBlocks(text) {
  if (!text || typeof text !== 'string') return text || '';
  // 匹配 ```tokfree ... ```（非贪婪，允许跨行）；语言标识后可有空白/换行
  const re = /```[ \t]*tokfree\b[\s\S]*?```/gi;
  let out = text.replace(re, '（已执行工具调用）');
  // 折叠因剔除产生的多余空行
  out = out.replace(/\n{3,}/g, '\n\n').replace(/^[ \t]*\n+/, '').trim();
  if (!out) out = '（已执行工具调用）';
  return out;
}

// ================= 用户消息附件提取 =================
// 用户消息里的附件：图片（blob:/data:/http 图）与文件卡片（含扩展名的文件名）。
// 跨上下文（壳层 vs webview）不能直接用 blob URL，需在 webview 内转 dataURL 回传。

const FILE_NAME_RE = /^[^\n]{1,120}\.(png|jpe?g|gif|webp|bmp|svg|pdf|txt|md|docx?|xlsx?|pptx?|csv|json|zip|gz|tar|7z|mp4|mp3|wav|mov)$/i;

/**
 * 从用户消息节点提取附件列表（只读）。
 * 图片：img[src] 为 blob:/data:/http(s) 且尺寸不太小（过滤头像/图标）。
 * 文件：文本恰好是「文件名.扩展名」的最内层元素（单行、≤120 字符）。
 * 图片的非 data: 源先记到 _src，由 extractConversation 异步转 dataURL。
 * @param {Element} node 用户消息节点
 * @returns {Array<{kind:string, name:string, thumb:string, _src?:string}>}
 */
function extractUserAttachments(node) {
  const out = [];
  if (!node) return out;
  const seen = new Set();

  // ① 图片附件
  try {
    const imgs = node.querySelectorAll('img');
    for (const img of imgs) {
      let src = '';
      try { src = img.currentSrc || img.getAttribute('src') || ''; } catch (_) {}
      if (!src) continue;
      if (src.indexOf('blob:') !== 0 && src.indexOf('data:') !== 0 && !/^https?:/i.test(src)) continue;
      // 过滤装饰性小图 / 头像（自然尺寸或布局尺寸过小）
      let w = 0, h = 0;
      try { w = img.naturalWidth || img.offsetWidth || 0; h = img.naturalHeight || img.offsetHeight || 0; } catch (_) {}
      if (w && h && (w < 32 || h < 32)) continue;
      const key = 'img:' + src;
      if (seen.has(key)) continue;
      seen.add(key);
      if (src.indexOf('data:') === 0) out.push({ kind: 'image', name: '图片', thumb: src });
      else out.push({ kind: 'image', name: '图片', thumb: '', _src: src });
    }
  } catch (_) {}

  // ② 文件附件（文件名卡片）
  try {
    const all = node.querySelectorAll('*');
    for (const el of all) {
      let t = '';
      try { t = (el.textContent || '').trim(); } catch (_) { continue; }
      if (!t || t.length > 120 || t.indexOf('\n') !== -1) continue;
      if (!FILE_NAME_RE.test(t)) continue;
      // 取最内层：若某子元素文本与当前完全一致，则当前不是最内层，跳过
      let hasInner = false;
      try {
        for (const c of el.children) { if ((c.textContent || '').trim() === t) { hasInner = true; break; } }
      } catch (_) {}
      if (hasInner) continue;
      const key = 'file:' + t;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: 'file', name: t, thumb: '' });
    }
  } catch (_) {}

  return out;
}

/**
 * 把图片源（blob:/http(s):）转成 dataURL（必须在拥有该资源的文档内执行才能读）。
 * 失败由调用方捕获并优雅降级为空 → 壳层显示「🖼 图片」。
 * @param {string} url
 * @returns {Promise<string>}
 */
function urlToDataURL(url) {
  return fetch(url, { credentials: 'include' })
    .then(function (r) { return r.blob(); })
    .then(function (b) {
      return new Promise(function (resolve, reject) {
        const fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result || '')); };
        fr.onerror = function () { reject(fr.error || new Error('FileReader failed')); };
        fr.readAsDataURL(b);
      });
    });
}

/** 从当前 URL 提取会话 ID（DeepSeek /chat/s/<id>） */
function extractSessionId() {
  try {
    const url = String(window.location.href || '');
    const m = url.match(/\/chat\/s\/([a-f0-9-]+)/i) || url.match(/\/s\/([a-f0-9-]+)/i);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

// ================= IndexedDB 全量消息（DeepSeek 虚拟滚动兜底） =================
// DeepSeek 网页 DOM 是虚拟滚动：.ds-message 只保留视口附近的少量节点，
// 中间/早期消息滚出视口后已从 DOM 移除，纯 DOM 提取永远只能拿到一部分。
// 但 DeepSeek 把整段会话的全量消息缓存在 IndexedDB 'deepseek-chat' → 'history-message'，
// 与虚拟滚动无关。因此优先从 IndexedDB 拿全量；拿不到或记录无正文字段时回退 DOM。

/** 从当前 URL 提取会话 ID（DeepSeek /chat/s/<id>） */
function getSessionIdFromUrl() {
  try {
    var m = String(window.location.href || '').match(new RegExp('/chat/s/([a-f0-9-]+)', 'i'));
    return m ? m[1] : null;
  } catch (_) { return null; }
}

/**
 * 从 IndexedDB 读取指定会话的全量原始消息记录（升序）。只读，失败 reject。
 * @param {string} sessionId
 * @returns {Promise<Array<object>>}
 */
function readSessionMessagesFromIDB(sessionId) {
  return new Promise(function (resolve, reject) {
    var req;
    try { req = indexedDB.open('deepseek-chat'); } catch (e) { reject(e); return; }
    req.onerror = function () { reject(new Error('打开 IndexedDB 失败')); };
    req.onsuccess = function () {
      var db = req.result;
      try {
        if (!db.objectStoreNames.contains('history-message')) {
          db.close(); reject(new Error('无 history-message store')); return;
        }
        var tx = db.transaction('history-message', 'readonly');
        var store = tx.objectStore('history-message');
        var g = store.get(sessionId);
        g.onsuccess = function () {
          db.close();
          var val = g.result;
          var msgs = val && val.data && val.data.chat_messages;
          if (!Array.isArray(msgs)) { reject(new Error('IndexedDB 无该会话消息')); return; }
          var list = msgs
            .filter(function (m) { return m && typeof m === 'object'; })
            .slice()
            .sort(function (a, b) { return (a.message_id || 0) - (b.message_id || 0); });
          resolve(list);
        };
        g.onerror = function () { db.close(); reject(new Error('读取消息失败')); };
      } catch (e) { try { db.close(); } catch (_) {} reject(e); }
    };
  });
}

/**
 * 从一条 IndexedDB 记录里探测正文字段（不同版本字段名可能不同）。
 * 兼容 content / text / markdown / thinking_content / reasoning_content / fragments。
 * @param {object} rec
 * @returns {string}
 */
function probeMessageText(rec) {
  if (!rec || typeof rec !== 'object') return '';
  var cands = ['content', 'text', 'markdown', 'thinking_content', 'reasoning_content'];
  for (var i = 0; i < cands.length; i++) {
    var v = rec[cands[i]];
    if (typeof v === 'string' && v.trim()) return v;
  }
  if (Array.isArray(rec.fragments)) {
    var out = '';
    for (var j = 0; j < rec.fragments.length; j++) {
      var f = rec.fragments[j];
      if (f && typeof f.content === 'string') out += f.content;
      else if (f && typeof f.text === 'string') out += f.text;
    }
    if (out.trim()) return out;
  }
  return '';
}

/**
 * 尝试用 IndexedDB 全量消息构建 Agent 视图消息列表。
 * 成功（至少一条有正文）返回 { sessionId, messages }；否则返回 null 表示应回退 DOM。
 * @returns {Promise<{sessionId:string, messages:Array}|null>}
 */
async function extractConversationFromIDB() {
  var sessionId = getSessionIdFromUrl();
  if (!sessionId) return null;
  var recs;
  try { recs = await readSessionMessagesFromIDB(sessionId); }
  catch (e) { console.log('[TokFree][extract] IndexedDB 读取失败，回退 DOM：' + (e && e.message)); return null; }
  if (!recs || !recs.length) { console.log('[TokFree][extract] IndexedDB 无消息，回退 DOM'); return null; }

  // 字段探测：打印首条记录的字段名（只打键名，不打正文）
  try { console.log('[TokFree][extract] IndexedDB 首条记录字段: ' + JSON.stringify(Object.keys(recs[0]))); } catch (_) {}

  var messages = [];
  var contentHits = 0;
  for (var i = 0; i < recs.length; i++) {
    var rec = recs[i];
    var role = String(rec.role || '').toUpperCase();
    var text = probeMessageText(rec);
    if (text) contentHits++;
    var isUser = role === 'USER';
    if (isUser) {
      if (isInitPromptText(text)) continue;
      if (isReceiptText(text)) { messages.push({ role: 'user', kind: 'receipt', text: text.slice(0, 800) }); continue; }
      var body = stripTokfreeBlocks(text);
      if (body.length > MAX_TEXT) body = body.slice(0, MAX_TEXT);
      if (!body) continue;
      messages.push({ role: 'user', kind: 'text', text: body });
    } else {
      var t = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
      messages.push({ role: 'ai', kind: 'message', html: '', text: t, thinking: [], steps: [] });
    }
  }
  if (!contentHits) { console.log('[TokFree][extract] IndexedDB 记录无正文字段，回退 DOM'); return null; }
  if (!messages.length) return null;
  return { sessionId: sessionId, messages: messages };
}

/**
 * 提取当前会话结构化内容。
 * 优先 IndexedDB 全量（规避虚拟滚动），失败/无正文则回退 DOM 提取。
 * @returns {{ok:boolean, generating:boolean, sessionId:string|null, messages:Array}}
 */
async function extractConversation() {
  const provider = safeGetProvider();
  let generating = false;
  try {
    if (provider && typeof provider.isGenerating === 'function') generating = !!provider.isGenerating();
  } catch (_) {}

  // API 型本地页（api-chat）：无 TokFree 覆盖层，DOM 也不含 .ds-message，
  // 走页面暴露的 __tokfreeApiChat.getMessages() 直接取结构化消息。
  try {
    if (typeof window !== 'undefined' && window.__tokfreeApiChat &&
        typeof window.__tokfreeApiChat.getMessages === 'function') {
      const raw = window.__tokfreeApiChat.getMessages() || [];
      const apiMessages = [];
      for (const m of raw) {
        apiMessages.push({
          role: (m.role === 'user') ? 'user' : 'ai',
          kind: 'message',
          html: m.html || '',
          text: m.text || '',
          thinking: [],
          steps: [],
        });
      }
      return { ok: true, generating: generating, sessionId: null, messages: apiMessages };
    }
  } catch (_) {}

  // 优先 DOM（格式最全：分段/思考/工具步骤）。
  // IndexedDB 里的正文是 Markdown/纯文本，解析回来会丢 html/thinking/steps，
  // 所以不再作为首选；仅当 DOM 完全为空时用它兜底补历史。
  const messages = [];
  const pendingThumbs = [];
  const nodes = getMessageNodes();
  for (const n of nodes) {
    let text = '';
    try { text = (n.innerText || n.textContent || '').trim(); } catch (_) {}
    const _isUser = isUserMessage(n, provider);
    if (!text && !_isUser) continue;
    if (_isUser) {
      // 初始化提示词消息：提取层直接跳过，Agent 视图不显示
      if (isInitPromptText(text)) {
        continue;
      }
      if (isReceiptText(text)) {
        messages.push({ role: 'user', kind: 'receipt', text: text.slice(0, 800) });
      } else {
        // 剔除用户消息里的 tokfree 工具代码块，只保留自然语言意图
        var _atts = extractUserAttachments(n);
        var _body = text ? stripTokfreeBlocks(text) : '';
        if (_atts.length && _body === '（已执行工具调用）') _body = '';
        text = _body;
        if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
        if (!text && !_atts.length) { continue; }
        var _m = { role: 'user', kind: 'text', text: text };
        if (_atts.length) {
          _m.attachments = _atts;
          for (var _ai = 0; _ai < _atts.length; _ai++) { if (_atts[_ai] && _atts[_ai]._src) pendingThumbs.push(_atts[_ai]); }
        }
        messages.push(_m);
      }
      continue;
    }
    messages.push(extractAiMessage(n, provider));
  }
  for (var _p = 0; _p < pendingThumbs.length; _p++) {
    var _pa = pendingThumbs[_p];
    try { _pa.thumb = await urlToDataURL(_pa._src); } catch (_) { _pa.thumb = ''; }
    delete _pa._src;
  }
  if (messages.length) {
    return { ok: true, generating: generating, sessionId: extractSessionId(), messages: messages };
  }

  // DOM 为空才回退 IndexedDB（纯文本兜底，格式次要）
  try {
    const idb = await extractConversationFromIDB();
    if (idb && Array.isArray(idb.messages) && idb.messages.length) {
      return { ok: true, generating: generating, sessionId: idb.sessionId, messages: idb.messages };
    }
  } catch (_) {}

  return { ok: true, generating: generating, sessionId: extractSessionId(), messages: messages };
}

module.exports = { extractConversation, extractConversationFromIDB, summarizeToolCode, isReceiptText, stripTokfreeBlocks, extractUserAttachments };

