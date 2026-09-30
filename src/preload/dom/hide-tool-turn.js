/**
 * 隐藏 TokFree 工具回合（P3）
 * 让对话界面不显示：
 *   1. AI 消息里的 tokfree 代码块（工具调用脚本）—— 连带该条消息一起隐藏
 *   2. 工具执行回执消息（【JS 执行结果汇总】/【工具执行结果】开头的用户消息）
 *   3. AI 的中间工具回合（发代码块那条消息）
 * 只保留：AI 的普通文字说明 + 最终结果 + "思考中"状态。
 *
 * 做法：用 MutationObserver 对新渲染的消息节点打标记，注入一条 CSS 隐藏被标记节点。
 * 不改动任何工具执行逻辑（执行照旧，只是不显示）。
 */
const { getProviderByUrl } = require('../../../src/providers');

// 被标记隐藏的节点属性 + 对应 CSS
const HIDE_ATTR = 'data-tokfree-hide';
const STYLE_ID = 'tokfree-hide-tool-style';
const HIDE_CSS = '[' + HIDE_ATTR + '="1"]{display:none !important;}';

// 初始化提示词隐藏：单独属性 + 单独 CSS。
// 该 CSS 无条件注入（开发者模式下也注入），确保初始化提示词在任何情况都不可见。
const HIDE_INIT_ATTR = 'data-tokfree-hide-init';
const STYLE_ID_INIT = 'tokfree-hide-init-style';
const INIT_HIDE_CSS = '[' + HIDE_INIT_ATTR + '="1"]{display:none !important;}';
// 初始化提示词零宽标记（与 chat-input.js 发送时追加的一致，从 localStorage 读取）
const INIT_MARKER_DEFAULT = '\u200B\u2063\u200B';
function getInitMarker() {
  try {
    return localStorage.getItem('tokfree-init-marker') || INIT_MARKER_DEFAULT;
  } catch (_) { return INIT_MARKER_DEFAULT; }
}

// 工具回执消息特征前缀（TokFree 注入的用户消息）
const RECEIPT_PREFIXES = [
  '【JS 执行结果汇总】',
  '【工具执行结果】',
];

// DeepSeek「思考过程」标题文本特征（混淆类名每个版本会变，标题文本相对稳定）
const THINK_HEADER_RE = /^(已深度思考|深度思考（|深度思考$|DeepSeek 思考了|Thought for \d+|Thinking\b)/;

// 各平台消息节点选择器（含 AI 与用户消息）。
// 用"每个选择器独立做最内层过滤"的方式收敛粒度：
// 同一选择器下，若某节点内部还包含同选择器匹配的节点，则丢弃外层，只保留最内层。
// 这样既能拿到"每条消息"，又绝不会误伤包含整段对话的外层容器（安全关键）。
const MSG_SELECTORS = [
  '.ds-message',                        // DeepSeek（AI + 用户）
  '[data-message-author-role]',         // ChatGPT
  '[class*="message-row"]',             // Claude / 自定义
  '[class*="qwen-chat-message"]',       // Qwen
  '.answer',                            // 智谱 AI 回复
  '[class*="question"]',                // 智谱用户消息
  '[class*="message"]',                 // 通用兜底
];

// 扫描节流
const SCAN_THROTTLE_MS = 400;
const RESCAN_INTERVAL_MS = 1500;

let scanTimer = null;
let observer = null;
let intervalId = null;
let started = false;

/** 取当前平台 provider（可能为 null） */
function getProvider() {
  try { return getProviderByUrl(window.location.href); } catch (_) { return null; }
}

/** 开发者模式（壳层右栏开关）：documentElement 打标 data-tokfree-dev="1"，此时不做任何隐藏 */
function isDevMode() {
  try {
    return document.documentElement && document.documentElement.getAttribute('data-tokfree-dev') === '1';
  } catch (_) { return false; }
}

/** 注入隐藏用 CSS（幂等；开发者模式下不注入，保持全部可见） */
function injectStyle() {
  try {
    if (document.getElementById(STYLE_ID)) return;
    if (isDevMode()) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = HIDE_CSS;
    (document.head || document.documentElement).appendChild(style);
  } catch (_) {}
}

/** 注入初始化提示词隐藏用 CSS（无条件注入，开发者模式下也注入） */
function injectInitStyle() {
  try {
    if (document.getElementById(STYLE_ID_INIT)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID_INIT;
    style.textContent = INIT_HIDE_CSS;
    (document.head || document.documentElement).appendChild(style);
  } catch (_) {}
}

/**
 * 判断消息节点是否为「初始化提示词」消息（文本含零宽标记）。
 * 该隐藏无条件生效（不受开发者模式影响）。
 */
function isInitPromptNode(node) {
  try {
    const raw = (node.textContent || '');
    if (!raw) return false;
    return raw.indexOf(getInitMarker()) !== -1;
  } catch (_) { return false; }
}

/** 给初始化提示词节点打隐藏标记（无条件，开发者模式下也隐藏） */
function markInitHide(node) {
  if (!node || !node.setAttribute) return;
  try {
    if (node.getAttribute(HIDE_INIT_ATTR) === '1') return;
    node.setAttribute(HIDE_INIT_ATTR, '1');
  } catch (_) {}
}

/**
 * 收集当前页面的消息节点。
 * 对每个选择器独立做"最内层过滤"（丢弃内部含同选择器匹配节点的外层节点），
 * 再把各选择器的结果并集返回。这样粒度稳定在"每条消息"，
 * 且绝不会把包含多条消息的外层容器当成一条消息而整段隐藏。
 */
function getMessageNodes() {
  const out = new Set();
  for (const sel of MSG_SELECTORS) {
    let nodes;
    try { nodes = document.querySelectorAll(sel); } catch (_) { continue; }
    const arr = Array.from(nodes);
    if (arr.length === 0) continue;
    // 单选择器内部：只保留最内层（不含同选择器其他匹配的节点）
    const inner = [];
    for (const n of arr) {
      let containsOther = false;
      for (const m of arr) {
        if (m !== n && n.contains(m)) { containsOther = true; break; }
      }
      if (!containsOther) inner.push(n);
    }
    for (const n of inner) out.add(n);
  }
  return Array.from(out);
}

/** 判断消息节点是否以工具回执前缀开头 */
function isReceiptNode(node) {
  let text = '';
  try { text = (node.innerText || node.textContent || '').trim(); } catch (_) { return false; }
  if (!text) return false;
  for (const p of RECEIPT_PREFIXES) {
    if (text.indexOf(p) === 0) return true;
  }
  return false;
}

/**
 * 判断消息节点内是否包含 tokfree 代码块。
 * 语言识别优先用 provider.getCodeBlockLanguage，其次 data-language、code 类名、代码块 banner 文本。
 */
function hasTokfreeBlock(node) {
  let pres;
  try { pres = node.querySelectorAll('pre'); } catch (_) { return false; }
  if (!pres || pres.length === 0) return false;
  const provider = getProvider();
  for (const pre of pres) {
    let lang = '';
    try {
      if (provider && typeof provider.getCodeBlockLanguage === 'function') {
        lang = provider.getCodeBlockLanguage(pre) || '';
      }
    } catch (_) {}
    if (String(lang).toLowerCase() === 'tokfree') return true;

    // data-language 兜底（pre 自身或其祖先容器）
    try {
      let dl = pre.getAttribute('data-language') || '';
      if (!dl) {
        const holder = pre.closest && pre.closest('[data-language]');
        if (holder) dl = holder.getAttribute('data-language') || '';
      }
      if (String(dl).toLowerCase() === 'tokfree') return true;
    } catch (_) {}

    // code 元素类名兜底
    try {
      const code = pre.querySelector('code');
      if (code) {
        const cls = typeof code.className === 'string' ? code.className : '';
        if (cls.toLowerCase().indexOf('tokfree') !== -1) return true;
      }
    } catch (_) {}

    // 代码块 banner / 头部文本兜底
    try {
      const block = (pre.closest && pre.closest('.md-code-block')) || pre.parentElement;
      if (block) {
        const banner = block.querySelector(
          '.md-code-block-banner, [class*="code-block-header"], [class*="banner"], [class*="lang"]'
        );
        if (banner && /tokfree/i.test(banner.textContent || '')) return true;
      }
    } catch (_) {}
  }
  return false;
}

/** 给节点打隐藏标记 */
function markHide(node) {
  if (!node || !node.setAttribute) return;
  try {
    if (node.getAttribute(HIDE_ATTR) === '1') return;
    node.setAttribute(HIDE_ATTR, '1');
  } catch (_) {}
}

/**
 * 在消息节点内找「思考过程」容器。
 * DeepSeek：思考块是 .ds-message 的直接子级（与最终答案 .ds-markdown 并列），
 *   标题为「已深度思考（用时 X 秒）」。混淆类名会随版本变化，故用标题文本定位，
 *   再向上爬到 .ds-message 的直接子级整个隐藏。
 * 其他平台：按 class 含 thinking/reasoning 启发式（隐藏仅影响显示，容错优先）。
 */
function findThinkingContainers(msgNode) {
  const out = [];
  const seen = new Set();
  const push = (el) => {
    if (el && el !== msgNode && !seen.has(el)) { seen.add(el); out.push(el); }
  };

  let cls = '';
  try { cls = typeof msgNode.className === 'string' ? msgNode.className : ''; } catch (_) {}

  if (cls.indexOf('ds-message') !== -1) {
    // DeepSeek 专用路径
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
          !(container.classList && container.classList.contains('ds-markdown'))) {
        push(container);
      }
    }
    return out;
  }

  // 其他平台启发式
  try {
    const generic = msgNode.querySelectorAll('[class*="thinking"], [class*="reasoning"], [class*="think-"], [class*="reason-"]');
    for (const g of generic) push(g);
  } catch (_) {}
  return out;
}

/** 全量扫描一遍，标记需隐藏的消息节点与思考块 */
function scan() {
  const nodes = getMessageNodes();
  // 先收集命中节点，再做一次"跨选择器最内层过滤"：
  // 若某命中节点内部还包含另一个命中节点，丢弃外层，只保留最内层。
  // 这是安全兜底，避免不同选择器交叉匹配时误隐藏包裹多条消息的外层容器。
  const hits = [];
  for (const n of nodes) {
    try {
      if (isReceiptNode(n) || hasTokfreeBlock(n)) hits.push(n);
    } catch (_) {}
  }
  if (hits.length > 0) {
    for (const n of hits) {
      let containsOther = false;
      for (const m of hits) {
        if (m !== n && n.contains(m)) { containsOther = true; break; }
      }
      if (!containsOther) markHide(n);
    }
  }
  // 初始化提示词：隐藏该消息（含开发者模式，无条件生效）。
  for (const n of nodes) {
    try {
      if (isInitPromptNode(n)) markInitHide(n);
    } catch (_) {}
  }
  // 思考过程块：隐藏消息内的「已深度思考/Thinking」容器，只留最终答案。
  // 开发者模式（壳层开发者开关设置 data-tokfree-dev="1"）下不隐藏。
  if (isDevMode()) return;
  for (const n of nodes) {
    try {
      const containers = findThinkingContainers(n);
      for (const c of containers) markHide(c);
    } catch (_) {}
  }
}

/** 节流调度一次扫描 */
function scheduleScan() {
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    scan();
  }, SCAN_THROTTLE_MS);
}

/** 启动隐藏逻辑（幂等） */
function start() {
  if (started) return;
  started = true;

  injectStyle();
  injectInitStyle();

  // 首屏扫描
  scan();
  // body 可能尚未就绪：稍后再补扫一次
  setTimeout(scan, 1000);

  // 监听新增消息 / 文本变化（流式渲染）
  try {
    observer = new MutationObserver(() => scheduleScan());
    const target = document.body || document.documentElement;
    if (target) {
      observer.observe(target, { childList: true, subtree: true, characterData: true });
    }
  } catch (e) {
    console.error('[TokFree] 隐藏工具回合：MutationObserver 启动失败:', e && e.message);
  }

  // 兜底轮询：SPA 重渲染 / 属性丢失时补标记
  intervalId = setInterval(scan, RESCAN_INTERVAL_MS);

  console.log('[TokFree] 已启动工具回合隐藏（tokfree 代码块消息 + 工具回执）');
}

/** 停止（供调试/卸载用） */
function stop() {
  started = false;
  try { if (observer) observer.disconnect(); } catch (_) {}
  observer = null;
  try { if (intervalId) clearInterval(intervalId); } catch (_) {}
  intervalId = null;
  try { if (scanTimer) clearTimeout(scanTimer); } catch (_) {}
  scanTimer = null;
}

module.exports = { start, stop, scan, findThinkingContainers };

