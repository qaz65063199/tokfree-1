/**
 * API 型 Provider：接入 OpenAI 兼容后端（如 chatgpt2api 号池）
 *
 * 与 DOM 型 provider 的区别：
 * - mode: 'api' —— 不操作第三方网页，而是加载本地聊天页 api-chat.html
 * - homeUrl 指向本地页；页面内通过 IPC 让主进程代理 HTTP 请求（避开 CORS）
 * - 复用统一 preload：页面渲染出标准 DOM 后，observer/工具执行/看门狗自动生效
 *
 * 兼容性：现有 provider 无 mode 字段，本文件不影响它们。
 */
const CHAT_PAGE = 'api-chat.html';

function localChatUrl() {
  // src/providers/api-openai.js → ../ui/api-chat.html
  const path = require('path');
  const url = require('url');
  const p = path.join(__dirname, '..', 'ui', CHAT_PAGE);
  return url.pathToFileURL(p).href;
}

module.exports = {
  id: 'api-openai',
  name: 'OpenAI 兼容 API',
  mode: 'api',
  useIntercept: false,
  // 本地聊天页的绝对 file:// URL（主进程/壳层据此建 webview）
  get homeUrl() { return localChatUrl(); },
  sessionUrlBase: '',

  matchesUrl(u) {
    if (!u) return false;
    return String(u).indexOf(CHAT_PAGE) !== -1;
  },

  // 本地页不是真实平台：输入框/按钮由页面自渲染，这里给出与页面一致的语义标记
  findInput() {
    return document.querySelector('#api-chat-input');
  },
  findSendButton() {
    return document.querySelector('#api-chat-send');
  },
  isGenerating() {
    const el = document.querySelector('#api-chat-status');
    return !!(el && el.getAttribute('data-generating') === 'true');
  },
  isResponseComplete() { return !this.isGenerating(); },
  isLoginPage() { return false; },
  isMainInterface() { return !!document.querySelector('#api-chat-input'); },
  extractSessionId() { return null; },
  extractUserInfo() { return ''; },

  // 消息容器：本地页渲染的 assistant 消息节点
  getMessageCandidates() {
    const list = Array.from(document.querySelectorAll('[data-role="assistant"]'));
    return list.filter((el) => !this.isUserMessage(el));
  },
  getMessageMarkdown(el) { return el ? (el.querySelector('.markdown') || el) : null; },
  isUserMessage(node) {
    let cur = node;
    while (cur) {
      if (cur.getAttribute && cur.getAttribute('data-role') === 'user') return true;
      cur = cur.parentElement;
    }
    return false;
  },
  getCodeBlockLanguage(pre) {
    try {
      const codeEl = pre.querySelector('code');
      const cls = (codeEl && codeEl.className) || '';
      const m = String(cls).match(/language-([\w-]+)/);
      return m ? m[1].toLowerCase() : '';
    } catch (_) { return ''; }
  },
};
