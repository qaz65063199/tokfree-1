/**
 * ChatGPT Provider 定义
 * 基于 chatgpt.com 页面结构，输入框为 ProseMirror（contenteditable）。
 */
let stopBtnVisible = false;
// 停止按钮首次出现的时间戳
let stopBtnFirstSeen = 0;
// 停止按钮需持续存在超过此阈值，才视为真正进入生成态。
// 过滤发送瞬间发送按钮↔停止按钮的短暂切换，避免误判为"回复完成"。
const MIN_GENERATING_MS = 1500;

module.exports = {
  id: 'chatgpt',
  name: 'ChatGPT',
  // 使用网络请求拦截方式获取 AI 回复（替代 DOM 抓取）
  useIntercept: true,
  homeUrl: 'https://chatgpt.com/',
  sessionUrlBase: 'https://chatgpt.com/c/',

  // 判断元素是否可见（offsetWidth/offsetHeight > 0）
  isElementVisible(el) {
    if (!el) return false;
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  },

  // 查找可见的聊天输入框（ChatGPT 用 ProseMirror contenteditable）
  // ⚠️ 排除 TokFree 覆盖层内的输入框（否则兜底 'textarea' 会命中覆盖层"补充说明"框）
  findInput() {
    const selectors = [
      'div[contenteditable="true"].ProseMirror',
      'div[role="textbox"]',
      'div.ProseMirror',
      'div[contenteditable="true"]',
      'textarea',
    ];
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el.closest && el.closest('#tokfree-overlay, [id^="tokfree-"]')) continue;
          if (this.isElementVisible(el)) return el;
        }
      } catch (_) {}
    }
    return null;
  },

  // 查找可见且未禁用的发送按钮
  findSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="发送提示词"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="Send"]',
    ];
    for (const sel of selectors) {
      try {
        const btns = document.querySelectorAll(sel);
        for (const btn of btns) {
          // ⚠️ 排除 TokFree 覆盖层按钮，避免误命中覆盖层的「卡住了？点我」按钮。
          if (btn.closest && btn.closest('#tokfree-overlay, [id^="tokfree-"]')) continue;
          if (this.isElementVisible(btn) && !btn.disabled) return btn;
        }
      } catch (_) {}
    }
    return null;
  },

  // 提取当前用户信息文本（异步：接口优先）
  // 1. 官方 /api/auth/session 接口（最稳，返回 user.name / user.email）
  // 2. DOM 兜底：个人资料按钮
  async extractUserInfo() {
    // 1. 官方 session 接口
    try {
      const r = await fetch('/api/auth/session', { credentials: 'include' });
      if (r.ok) {
        const j = await r.json();
        const u = j && j.user;
        if (u && (u.name || u.email)) {
          return String(u.name || u.email).trim();
        }
      }
    } catch (_) {}

    // 2. localStorage 兜底（历史实现，部分版本仍有效）
    try {
      const raw = localStorage.getItem('oai/apps/accountSwitchSessions');
      if (raw) {
        const sessions = JSON.parse(raw);
        if (Array.isArray(sessions) && sessions.length > 0 && sessions[0].name) {
          return String(sessions[0].name).trim();
        }
      }
    } catch (_) {}

    // 3. DOM 兜底：个人资料按钮
    const btn = document.querySelector('[data-testid="accounts-profile-button"]') ||
      document.querySelector('[data-testid="profile-button"]') ||
      document.querySelector('button[aria-label*="profile" i]') ||
      document.querySelector('button[aria-label*="account" i]');
    if (btn) {
      const aria = btn.getAttribute('aria-label') || '';
      if (aria) return aria.trim();
    }

    return '';
  },

  // 首页判断正则（https://chatgpt.com/ 或 https://chatgpt.com）
  homeUrlPattern: /^https:\/\/chatgpt\.com\/?$/,

  // 从 URL 提取会话 ID（ChatGPT 是 /c/xxx 格式）
  // 从 URL 提取会话 ID（ChatGPT 是 /c/{uuid} 格式）
  // 注意：创建会话过程中 URL 有中间态 /c/WEB:xxx，不能把 WEB 当会话 ID。
  // session-store 会优先使用本方法的返回值，故此处必须自行排除 WEB。
  extractSessionId(url) {
    if (!url) return null;
    // 优先匹配完整 UUID（正式会话 ID）
    const uuidMatch = url.match(/\/c\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    if (uuidMatch) return uuidMatch[1];
    // 回退通用匹配，排除中间态 WEB
    const genericMatch = url.match(/\/c\/([a-zA-Z0-9_-]+)/i);
    if (genericMatch && genericMatch[1] !== 'WEB') return genericMatch[1];
    return null;
  },

  // 判断 URL 是否属于本平台
  matchesUrl(url) {
    return url.includes('chatgpt.com') || url.includes('chat.openai.com');
  },

  // ========== 自动解析相关方法 ==========

  // 是否正在生成中（停止按钮存在 → 运行中）
  isGenerating() {
    // 多策略：testid 优先 → 语义属性 → 宽 class 兜底，命中可见元素即视为生成中。
    const selectors = [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="停止"]',
      'button[title*="Stop"]',
      'button[class*="stop"]',
    ];
    try {
      for (const sel of selectors) {
        let els;
        try { els = document.querySelectorAll(sel); } catch (_) { continue; }
        for (const el of els) {
          if (el && el.offsetWidth > 0) return true;
        }
      }
      return false;
    } catch (_) { return false; }
  },

  // 判断 AI 是否已完成回复（基于停止按钮的边沿触发）
  // 回答中：button[data-testid="stop-button"] 存在
  // 回答完成：该按钮消失；从存在到消失的边沿才返回 true，避免持续触发
  async isResponseComplete() {
    const stopBtn = document.querySelector('button[data-testid="stop-button"]');
    const visible = !!stopBtn;
    const now = Date.now();

    if (visible) {
      if (!stopBtnVisible) {
        // 停止按钮首次出现，记录时间，避免发送瞬间的短暂切换被误判
        stopBtnFirstSeen = now;
      }
      stopBtnVisible = true;
      return false;
    }

    // 上一次可见、本次不可见 → 需确认生成态持续足够久，才认定为回复结束
    if (stopBtnVisible) {
      stopBtnVisible = false;
      const generatingMs = now - stopBtnFirstSeen;
      if (generatingMs < MIN_GENERATING_MS) {
        // 生成态过短：发送按钮↔停止按钮的短暂切换，忽略，避免误判完成
        console.log('[' + new Date().toISOString() + '] [TokFree] ChatGPT 停止按钮仅存在 ' + generatingMs + 'ms（<' + MIN_GENERATING_MS + 'ms），忽略本次完成信号');
        return false;
      }
      console.log('[' + new Date().toISOString() + '] [TokFree] ChatGPT 回复完成，等待 500ms 后解析');
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log('[' + new Date().toISOString() + '] [TokFree] ChatGPT 500ms 等待结束');
      return true;
    }

    return false;
  },

  // 获取当前页面所有 AI 消息容器（排除用户消息）
  getMessageCandidates() {
    return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).filter(el => !this.isUserMessage(el));
  },

  // 从消息容器中取回复内容根节点
  getMessageMarkdown(messageEl) {
    return messageEl.querySelector('[class*="markdown"]') ||
      messageEl.querySelector('div[class*="prose"]') ||
      messageEl;
  },

  // 判断节点是否位于用户消息区域内
  isUserMessage(node) {
    let current = node;
    while (current) {
      const role = current.getAttribute?.('data-message-author-role') || '';
      if (role === 'user') return true;
      current = current.parentElement;
    }
    const userEl = node && node.closest ? node.closest('[data-message-author-role="user"]') : null;
    if (userEl) return true;
    const text = (node.textContent || node.innerText || '').substring(0, 200);
    return text.includes('我已选择目录：') || text.includes('系统提示词：') || text.includes('工具使用规则：');
  },

  // 提取代码块的语言标记
  // ChatGPT 代码块的语言标签在 header 里（如 <svg/>tokfree），不在 class 中。
  getCodeBlockLanguage(pre) {
    if (!pre) return '';
    // 1. 先尝试 class（兼容其他渲染方式）
    const codeEl = pre.querySelector('code');
    const els = [codeEl, pre].filter(Boolean);
    for (const el of els) {
      const cls = el.className || '';
      if (typeof cls === 'string') {
        const langMatch = cls.match(/language-([\w-]+)/);
        if (langMatch) return langMatch[1].toLowerCase();
      }
    }
    // 2. 从代码块 header 提取语言标签
    const header = pre.querySelector('[class*="items-center"][class*="text-sm"]');
    if (header) {
      const clone = header.cloneNode(true);
      clone.querySelectorAll('svg, button').forEach(el => el.remove());
      const langText = (clone.textContent || '').trim();
      if (/^[a-zA-Z0-9_+#.-]{1,20}$/.test(langText)) {
        return langText.toLowerCase();
      }
    }
    return '';
  },

  // 排除 TokFree 覆盖层元素（覆盖层按钮也含中文文案，不排除会误命中）
  __isTokFreeOverlay(el) {
    try {
      if (!el || typeof el.closest !== 'function') return false;
      return !!el.closest('#tokfree-overlay, #tokfree-window-manager, #tokfree-settings-drawer, [id^="tokfree-"]');
    } catch (_) { return false; }
  },

  // ========== 登录页检测（供 login-manager 用）==========
  // ChatGPT 支持账密 + Google 登录；未登录页有可见「登录 / 免费注册」入口，
  // 登录后右上角显示账号头像/账号菜单。此处只做「是否登录」判断，
  // 不实现账密表单方法（自动登录由 login-manager 统一处理）。

  // 是否存在「已登录」信号：账号头像 / 账号菜单按钮。
  __hasLoggedInSignal() {
    try {
      const sels = [
        '[data-testid="accounts-profile-button"]',
        '[data-testid="profile-button"]',
        'button[aria-label*="profile" i]',
        'button[aria-label*="account" i]',
        'button[aria-label*="账号" i]',
        'button[aria-label*="个人资料" i]',
        'img[alt*="profile" i]',
        '[data-testid="accounts-profile-button"] img',
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

  // 是否存在可见的「登录 / 免费注册 / Sign in」入口。
  __hasVisibleSignIn() {
    try {
      const btns = document.querySelectorAll('a, button, [role="button"]');
      const exact = ['登录', '登 录', '免费注册', '注册', 'Sign in', 'Sign up', 'Log in', 'Log in / Sign up'];
      for (const b of btns) {
        if (this.__isTokFreeOverlay(b)) continue;
        const t = (b.textContent || '').trim();
        const al = (b.getAttribute('aria-label') || '').trim();
        const isSignInText = exact.includes(t);
        const isSignInAria = /^(sign in|log in|sign up|登录|注册)$/i.test(al);
        if ((isSignInText || isSignInAria) && this.isElementVisible(b)) return true;
      }
      return false;
    } catch (_) { return false; }
  },

  // 当前是否在登录页（未登录）：存在可见登录入口 且 无已登录信号。
  isLoginPage() {
    try {
      if (this.__hasLoggedInSignal()) return false;   // 有账号信号 = 已登录
      if (this.__hasVisibleSignIn()) return true;      // 有登录入口 = 未登录
      return false;
    } catch (_) { return false; }
  },

  // 是否已进入主界面（已登录）。
  // 优先看已登录信号（头像/账号菜单）；无该信号时退化为
  // 「有可见输入框 且 无可见登录入口」。
  isMainInterface() {
    try {
      if (this.__hasLoggedInSignal()) return true;
      if (this.__hasVisibleSignIn()) return false;     // 有登录入口 = 未登录
      return !!this.findInput();
    } catch (_) { return false; }
  },

  // 查找「深度思考」开关/入口按钮元素；找不到返回 null
  // ⚠️ 骨架实现（选择器待真机确认）：ChatGPT 的思考入口是模型选择器（如 GPT-5-thinking），
  //    真实 DOM 随版本变化且未登录态无法采集，故此处用多策略容错：
  //    ① 输入框附近容器内按文案/aria-label 匹配 think/思考/reasoning；② 属性/data-testid 兜底。
  //    拿到真机 DOM 后，优先把专属 class/data-testid 补入下方 attrSelectors。
  getDeepThinkButton() {
    try {
      // ⭐ 首选（真机确认）：ChatGPT 深度思考入口是输入框工具栏的 pill 按钮
      //   button.__composer-pill.__composer-pill--neutral（文案"思考"），
      //   其 aria-pressed 表示开关态（false=关，true=开）。
      try {
        const pills = document.querySelectorAll('button.__composer-pill');
        for (const el of pills) {
          if (this.__isTokFreeOverlay(el)) continue;
          if (!this.isElementVisible(el)) continue;
          // 优先取文案匹配"思考/think"的 pill，避免命中其它 pill（如"附件"）
          const t = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
          if (/思考|think|reasoning|推理/i.test(t) || el.getAttribute('aria-pressed') != null) {
            return el;
          }
        }
      } catch (_) {}

      const textRe = /think|思考|reasoning|推理|extended/i;
      const isClickable = (el) => {
        try {
          if (!el) return false;
          if (el.tagName === 'BUTTON') return true;
          if (el.getAttribute && el.getAttribute('role') === 'button') return true;
          if (el.getAttribute && el.getAttribute('aria-pressed') != null) return true;
          if (el.getAttribute && el.getAttribute('aria-checked') != null) return true;
          return false;
        } catch (_) { return false; }
      };

      // 策略1：限定在「输入框附近的容器」内按文案/aria-label 查找（避免命中 AI 回复正文里的「思考」字样）
      let root = document;
      try {
        const input = this.findInput ? this.findInput() : null;
        if (input && input.closest) {
          let box = input;
          let scope = null;
          for (let up = 0; up < 6 && box && box.parentElement; up++) {
            box = box.parentElement;
            if (this.__isTokFreeOverlay(box)) break;
            if (box.querySelector('button, [role="button"]')) scope = box;
          }
          if (scope) root = scope;
        }
      } catch (_) {}

      const labelOf = (el) => {
        const aria = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '';
        return aria || (el.textContent || '').trim();
      };
      const cands = root.querySelectorAll('button, [role="button"], [aria-haspopup], span');
      let best = null;
      for (const el of cands) {
        if (this.__isTokFreeOverlay(el)) continue;
        if (!this.isElementVisible(el)) continue;
        const t = labelOf(el);
        if (!t || t.length > 30) continue;
        if (!textRe.test(t)) continue;
        // 取最内层（文案最短）的候选，再向上找最近的可点击祖先
        if (!best || t.length < labelOf(best).length) best = el;
      }
      if (best) {
        if (isClickable(best)) return best;
        let up = best;
        for (let i = 0; i < 3 && up && up.parentElement; i++) {
          const p = up.parentElement;
          if (this.__isTokFreeOverlay(p)) break;
          if (isClickable(p)) return p;
          up = p;
        }
        return best;
      }

      // 策略2：属性 / data-testid 兜底（文案无法命中时的多策略容错）
      const attrSelectors = [
        '[aria-pressed][class*="think"]',
        '[aria-pressed][class*="reason"]',
        '[class*="thinking"][role="button"]',
        '[class*="reasoning"][role="button"]',
        '[data-testid*="thinking"]',
        '[data-testid*="reasoning"]',
        '[data-testid*="model-switcher"]',
      ];
      for (const sel of attrSelectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (this.__isTokFreeOverlay(el)) continue;
            if (!this.isElementVisible(el)) continue;
            return el;
          }
        } catch (_) {}
      }
      return null;
    } catch (_) { return null; }
  },

  // 深度思考按钮是否处于「开启」态（容错；找不到按钮返回 false）
  isDeepThinkOn() {
    try {
      const btn = this.getDeepThinkButton();
      if (!btn) return false;
      const ap = btn.getAttribute && btn.getAttribute('aria-pressed');
      if (ap === 'true') return true;
      if (ap === 'false') return false;
      const ac = btn.getAttribute && btn.getAttribute('aria-checked');
      if (ac === 'true') return true;
      if (ac === 'false') return false;
      const cls = (typeof btn.className === 'string' ? btn.className : '') || '';
      if (/active|selected|checked|enabled|is-on|primary|filled/i.test(cls)) return true;
      try {
        const inner = btn.querySelector('[class*="active"], [class*="selected"], [class*="checked"]');
        if (inner) return true;
      } catch (_) {}
      return false;
    } catch (_) { return false; }
  },

  // 把深度思考切到目标状态（已是目标态则不动）；找不到按钮保守返回 available:false
  // @returns {{ok:boolean, changed:boolean, available:boolean, error?:string}}
  setDeepThink(on) {
    try {
      const btn = this.getDeepThinkButton();
      if (!btn) return { ok: false, changed: false, available: false };
      const want = !!on;
      if (this.isDeepThinkOn() === want) return { ok: true, changed: false, available: true };
      // ChatGPT 为 React 站点，必须用原生 el.click()（鼠标事件序列无效）
      try {
        btn.click();
      } catch (_) {
        return { ok: false, changed: false, available: true, error: 'click failed' };
      }
      return { ok: true, changed: true, available: true };
    } catch (err) {
      return { ok: false, changed: false, error: (err && err.message) || String(err) };
    }
  },
};
