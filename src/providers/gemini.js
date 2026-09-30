/**
 * Google Gemini（gemini.google.com）Provider 定义
 *
 * 模式：useIntercept: false —— DOM 抓取模式
 *   （比拦截 batchexecute RPC 稳定；Gemini 的流式 RPC 结构复杂且版本易变）
 *
 * 真机 DOM 探测结论（2026-09-23，未登录状态，Edge/Electron）：
 * - 输入框：<rich-textarea> 内的 div.ql-editor[contenteditable="true"][role="textbox"]
 *   aria-label="为 Gemini 输入提示"，data-placeholder="问问 Gemini"
 * - 发送按钮：button[aria-label="发送"]（英文站为 button[aria-label="Send"]），
 *   mat-icon fonticon="arrow_upward"；空输入时该按钮不存在/禁用
 * - 生成中：发送按钮（arrow_upward）被替换为「停止」按钮（fonticon="stop"，
 *   aria-label 含"停止"/"Stop"）
 * - 消息容器（登录后可见，需真机登录验证）：
 *   AI 回复：.model-response-text / message-content / .conversation-container 内的 model-response
 *   用户消息：.query-text / user-query
 * - 会话 URL：https://gemini.google.com/app/{chatId}；首页：https://gemini.google.com/app
 * - 首页/未登录信号：出现可见的「登录 / Sign in」按钮、无 ql-editor 以外内容
 *
 * ⚠️ 登录后消息容器 class 可能与未登录探测有出入，相关选择器已做多策略容错；
 *    若真机发现差异，请以实际 DOM 为准调整 getMessageCandidates / isUserMessage。
 *
 * 主进程使用：homeUrl（打开窗口）、sessionUrlBase（导航到会话）
 * preload 使用：输入框/发送按钮查找、回复完成检测、消息解析
 */

// 停止按钮需持续存在超过此阈值，才视为真正进入生成态（过滤发送瞬间的按钮切换抖动）
const MIN_GENERATING_MS = 1200;

module.exports = {
  id: 'gemini',
  name: 'Gemini',
  // 使用 DOM 抓取方式获取 AI 回复
  useIntercept: false,
  homeUrl: 'https://gemini.google.com/app',
  sessionUrlBase: 'https://gemini.google.com/app/',

  // 判断元素是否可见（offsetWidth/offsetHeight > 0）
  isElementVisible(el) {
    if (!el) return false;
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  },

  // 排除 TokFree 覆盖层元素
  __isTokFreeOverlay(el) {
    try {
      if (!el || typeof el.closest !== 'function') return false;
      return !!el.closest('#tokfree-overlay, #tokfree-window-manager, #tokfree-settings-drawer, [id^="tokfree-"]');
    } catch (_) { return false; }
  },

  // 查找可见的聊天输入框（Gemini 用 Quill 富文本：div.ql-editor[contenteditable]）
  // ⚠️ 排除 TokFree 覆盖层内的输入框（否则兜底 contenteditable 会命中覆盖层）
  findInput() {
    const selectors = [
      'rich-textarea .ql-editor[contenteditable="true"]',
      'rich-textarea div[contenteditable="true"]',
      'div.ql-editor[contenteditable="true"]',
      '.text-input-field [contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      '[role="textbox"]',
      'textarea',
    ];
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (this.__isTokFreeOverlay(el)) continue;
          // Quill 的隐藏剪贴板 div.ql-clipboard 也是 contenteditable，需排除
          if (el.classList && el.classList.contains('ql-clipboard')) continue;
          if (this.isElementVisible(el)) return el;
        }
      } catch (_) { /* 选择器不合法时跳过 */ }
    }
    return null;
  },

  // 查找可见且未禁用的发送按钮
  // Gemini 发送按钮：button[aria-label="发送"/"Send"]，图标 fonticon=arrow_upward
  findSendButton() {
    const selectors = [
      'button[aria-label="发送"]',
      'button[aria-label="Send"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="Send"]',
      'button.send-button',
      'button[type="submit"]',
    ];
    for (const sel of selectors) {
      try {
        const btns = document.querySelectorAll(sel);
        for (const btn of btns) {
          if (this.__isTokFreeOverlay(btn)) continue;
          if (!this.isElementVisible(btn) || btn.disabled) continue;
          // 排除「停止」按钮（生成中与发送键可能相邻）
          const lb = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '');
          if (/停止|stop/i.test(lb)) continue;
          return btn;
        }
      } catch (_) { /* 选择器不合法时跳过 */ }
    }
    return null;
  },

  // 站点原生发送：Gemini 发送键是标准 button，直接原生 click 即可；
  // 兜底用主进程 sendInputEvent 注入原生 Enter（Quill 编辑器对合成事件可能免疫）。
  async triggerSend(input) {
    const btn = this.findSendButton();
    if (btn) {
      try { btn.click(); return true; } catch (_) {}
    }
    if (input && window.electronAPI && typeof window.electronAPI.sendEnterToChat === 'function') {
      try {
        await window.electronAPI.sendEnterToChat();
        return true;
      } catch (_) { /* IPC 失败时回退通用逻辑 */ }
    }
    return false;
  },

  // 提取当前用户信息文本（登录后侧栏显示邮箱/昵称；未登录返回空）
  extractUserInfo() {
    const selectors = [
      '[class*="user-info"] [class*="name"]',
      '[class*="user-name"]',
      '[class*="user-email"]',
      'img[alt][class*="avatar"]',
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        const text = (el.getAttribute && el.getAttribute('alt')) || (el.textContent || '').trim();
        if (text && text.length <= 60) return text;
      } catch (_) { /* 忽略 */ }
    }
    return '';
  },

  // 首页判断正则（gemini.google.com/app 根路径，或 /app 下无会话 ID）
  homeUrlPattern: /^https:\/\/gemini\.google\.com\/app\/?(\?.*)?$/,

  // 从 URL 提取会话 ID（https://gemini.google.com/app/{chatId}）
  // 注意：/app 本身是首页，无会话 ID
  extractSessionId(url) {
    if (!url) return null;
    const m = url.match(/\/app\/([a-zA-Z0-9_-]+)/i);
    if (!m) return null;
    const id = m[1];
    // 保留路由
    if (/^(app|new|guest)$/i.test(id)) return null;
    return id;
  },

  // 判断 URL 是否属于本平台
  matchesUrl(url) {
    if (!url) return false;
    try {
      const host = new URL(url).hostname;
      return /(^|\.)gemini\.google\.com$/i.test(host);
    } catch (_) {
      return String(url).includes('gemini.google.com');
    }
  },

  // ========== 自动解析相关方法 ==========

  // 是否正在生成中（生成中发送键被替换为「停止」按钮）
  isGenerating() {
    try {
      const stop = document.querySelector(
        'button[aria-label*="停止"], button[aria-label*="Stop"], button[aria-label*="stop"]'
      );
      if (stop && this.isElementVisible(stop)) return true;
      // 兜底：fonticon=stop 的 mat-icon 所在按钮
      const stopIcon = document.querySelector('mat-icon[fonticon="stop"], button [fonticon="stop"]');
      if (stopIcon) {
        const btn = stopIcon.closest && stopIcon.closest('button');
        if (btn && this.isElementVisible(btn)) return true;
      }
      return false;
    } catch (_) { return false; }
  },

  // 判断 AI 是否已完成回复（基于停止按钮的边沿触发）
  async isResponseComplete() {
    const now = Date.now();
    const visible = this.isGenerating();
    if (visible) {
      if (!this.__stopBtnVisible) this.__stopBtnFirstSeen = now;
      this.__stopBtnVisible = true;
      return false;
    }
    if (this.__stopBtnVisible) {
      this.__stopBtnVisible = false;
      const generatingMs = now - (this.__stopBtnFirstSeen || now);
      if (generatingMs < MIN_GENERATING_MS) {
        console.log('[TokFree] Gemini 停止按钮仅存在 ' + generatingMs + 'ms（<' + MIN_GENERATING_MS + 'ms），忽略本次完成信号');
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
      return true;
    }
    return false;
  },

  // 获取当前页面所有 AI 消息容器（排除用户消息）
  // ⚠️ 需真机登录验证：登录后 Gemini 回复容器常见为 .model-response-text / model-response
  getMessageCandidates() {
    const selectors = [
      '.model-response-text',
      'message-content.model-response-text',
      'model-response .markdown',
      '.conversation-container .model-response-text',
      '[class*="model-response"]',
      'message-content',
    ];
    for (const sel of selectors) {
      try {
        const list = document.querySelectorAll(sel);
        if (list && list.length > 0) {
          const arr = Array.from(list).filter(el => !this.isUserMessage(el));
          if (arr.length > 0) return arr;
        }
      } catch (_) { /* 忽略 */ }
    }
    return [];
  },

  // 从消息容器中取回复内容根节点
  getMessageMarkdown(messageEl) {
    if (!messageEl) return null;
    return messageEl.querySelector('.markdown') ||
      messageEl.querySelector('[class*="markdown"]') ||
      messageEl.querySelector('.model-response-text') ||
      messageEl;
  },

  // 判断节点是否位于用户消息区域内
  isUserMessage(node) {
    let current = node;
    while (current) {
      const cls = current.className || '';
      if (typeof cls === 'string' && /user-query|query-text|user-message/i.test(cls)) return true;
      const tag = (current.tagName || '').toLowerCase();
      if (tag === 'user-query' || tag === 'user-query-content') return true;
      const role = (current.getAttribute && (current.getAttribute('data-role') || current.getAttribute('data-author'))) || '';
      if (role === 'user' || role === 'human') return true;
      current = current.parentElement;
    }
    const text = (node.textContent || node.innerText || '').substring(0, 200);
    return text.includes('我已选择目录：') || text.includes('系统提示词：') || text.includes('工具使用规则：');
  },

  // 提取代码块的语言标记（小写）
  getCodeBlockLanguage(pre) {
    if (!pre) return '';
    // 1. code / pre 上的 language-xxx
    try {
      const codeEl = pre.querySelector('code');
      const els = [codeEl, pre].filter(Boolean);
      for (const el of els) {
        const cls = el.className || '';
        if (typeof cls === 'string') {
          const m = cls.match(/language-([\w-]+)/);
          if (m) return m[1].toLowerCase();
        }
      }
    } catch (_) { /* 忽略 */ }
    // 2. data-language 属性
    try {
      let lang = pre.getAttribute('data-language') || '';
      if (!lang) {
        const parentDiv = pre.closest('[data-language]');
        if (parentDiv) lang = parentDiv.getAttribute('data-language') || '';
      }
      if (lang) return lang.toLowerCase();
    } catch (_) { /* 忽略 */ }
    return '';
  },

  // ========== 登录页检测（供 login-manager 用）==========
  // Gemini 用 Google 账号登录，无法用账密自动登录（OAuth 页），
  // 故 isLoginPage 仅用于判断"是否未登录"，自动登录链路不适用。

  // 是否存在「已登录」信号：账号头像 / 账号菜单 / 退出登录入口。
  // Gemini 登录后右上角 Google 栏显示账号头像（替代未登录时的「登录」按钮），未登录无此信号。
  __hasLoggedInSignal() {
    try {
      const sels = [
        'img[alt*="Google 账号" i]',
        'img[alt*="Google Account" i]',
        'img[alt*="profile" i]',
        'a[href*="SignOutOptions"]',
        'a[href*="accounts.google.com/SignOutOptions"]',
        '[aria-label*="Google 账号" i]',
        '[aria-label*="Google Account" i]',
        '[aria-label*="退出" i]',
        '[aria-label*="Sign out" i]',
      ];
      for (const sel of sels) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (this.__isTokFreeOverlay(el)) continue;
            if (this.isElementVisible(el)) return true;
          }
        } catch (_) { /* 非法选择器跳过 */ }
      }
      return false;
    } catch (_) { return false; }
  },

  // 是否存在可见的「登录 / Sign in」入口。
  // ⚠️ 未登录的 Gemini 页面【输入框也可见】（ql-editor 一直存在），
  //    故登录态必须看登录/登出信号，而不是看有无输入框。
  __hasVisibleSignIn() {
    try {
      const btns = document.querySelectorAll('a, button, [role="button"]');
      for (const b of btns) {
        if (this.__isTokFreeOverlay(b)) continue;
        const t = (b.textContent || '').trim();
        const al = (b.getAttribute('aria-label') || '').trim();
        const isSignInText = (t === '登录' || t === '登 录' || t === 'Sign in' || t === 'Sign In' || t === 'Log in');
        const isSignInAria = /^(sign in|log in|登录)$/i.test(al);
        if ((isSignInText || isSignInAria) && this.isElementVisible(b)) return true;
      }
      return false;
    } catch (_) { return false; }
  },

  // 当前是否在登录页（未登录）：存在可见登录入口 且 无已登录信号。
  // ⚠️ 关键：不能因「找到输入框」就判为非登录页——未登录时输入框同样可见。
  isLoginPage() {
    try {
      if (this.__hasLoggedInSignal()) return false;   // 有账号信号 = 已登录
      if (this.__hasVisibleSignIn()) return true;      // 有登录入口 = 未登录
      return false;
    } catch (_) { return false; }
  },

  // 是否已进入主界面（已登录）。
  // 优先看已登录信号（头像/账号菜单）；无该信号时退化为
  // 「有可见输入框 且 无可见登录入口」——不再单纯以输入框判定。
  isMainInterface() {
    try {
      if (this.__hasLoggedInSignal()) return true;
      if (this.__hasVisibleSignIn()) return false;     // 有登录入口 = 未登录
      return !!this.findInput();
    } catch (_) { return false; }
  },

  // ========== 深度思考开关 ==========
  // Gemini 有「Deep Research / 深度研究」等模式，但入口与 DOM 结构随版本变化较大，
  // 当前统一容错返回（找不到即视为不可用），不阻塞主流程。

  getDeepThinkButton() {
    return null;
  },

  isDeepThinkOn() {
    return false;
  },

  setDeepThink(on) {
    return { ok: false, changed: false, available: false };
  },
};
