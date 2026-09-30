/**
 * Qwen（千问海外版 chat.qwen.ai）Provider 定义
 *
 * 页面结构要点（基于 qwen-chat-fe 前端实测）：
 * - 输入框：React 受控 textarea，class 为 message-input-textarea，placeholder 为 "Ask Qwen"
 * - 发送按钮：button.send-button（生成中会被替换为 button.stop-button）
 * - 消息容器：div.qwen-chat-message，按角色带 -user / -assistant 后缀
 * - 正文根节点：.qwen-markdown
 * - 代码块：pre.qwen-markdown-code，语言标记在 .qwen-markdown-code-header 首个子节点文本
 *
 * 主进程使用：homeUrl（打开窗口）、sessionUrlBase（导航到会话）
 * preload 使用：输入框/发送按钮查找、回复完成检测、消息解析
 */
let stopBtnVisible = false;
// 停止按钮首次出现的时间戳
let stopBtnFirstSeen = 0;
// 停止按钮需持续存在超过此阈值，才视为真正进入生成态（过滤发送瞬间的按钮切换抖动）
const MIN_GENERATING_MS = 1500;

// 会话路由中属于「新建」而非真实会话的保留字
const RESERVED_SEGMENTS = ['new-chat', 'new-branch', 'guest', 'new'];

module.exports = {
  id: 'qwen',
  name: 'Qwen',
  // 启用 SSE 拦截器（src/interceptor/qwen-hook.js 已能解析 /api/chat/completions 的
  // OpenAI 兼容 SSE，含 response.stopped / [DONE] / delta.status=finished 多种流结束信号）
  useIntercept: true,
  homeUrl: 'https://chat.qwen.ai/',
  sessionUrlBase: 'https://chat.qwen.ai/c/',

  // 判断元素是否可见（offsetWidth/offsetHeight > 0）
  isElementVisible(el) {
    if (!el) return false;
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  },

  // 查找可见的聊天输入框
  // ⚠️ 排除 TokFree 覆盖层内的输入框（否则兜底 'textarea' 会命中覆盖层"补充说明"框）
  findInput() {
    const selectors = [
      'textarea.message-input-textarea',
      '#message-input-container textarea.message-input-textarea',
      'textarea[placeholder*="Ask Qwen"]',
      '.qwen-chat-v2-input-textarea textarea',
      '#qwen-chat-v2-input-textarea textarea',
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="ask"]',
      'div[contenteditable="true"]',
      '[role="textbox"]',
      'textarea',
    ];
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el.closest && el.closest('#tokfree-overlay, [id^="tokfree-"]')) continue;
          if (this.isElementVisible(el)) return el;
        }
      } catch (_) { /* 选择器不合法时跳过 */ }
    }
    return null;
  },

  // 查找可见且未禁用的发送按钮
  findSendButton() {
    const selectors = [
      '.message-input-right-button-send button.send-button',
      '.chat-prompt-send-button button.send-button',
      'button.send-button',
      'button[aria-label="Send"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]',
    ];
    for (const sel of selectors) {
      try {
        const btns = document.querySelectorAll(sel);
        for (const btn of btns) {
          // ⚠️ 排除 TokFree 覆盖层按钮，避免误命中覆盖层的「卡住了？点我」按钮。
          if (btn.closest && btn.closest('#tokfree-overlay, [id^="tokfree-"]')) continue;
          if (this.isElementVisible(btn) && !btn.disabled) return btn;
        }
      } catch (_) { /* 选择器不合法时跳过 */ }
    }
    return null;
  },

  // 站点原生发送：Qwen 的发送按钮为 button.send-button；
  // 生成态下该按钮被替换为 button.stop-button，需避免误点停止键。
  // 多策略兜底：可见点击 → 隐藏元素程序化 click → 相对定位 → 主进程原生 Enter 注入。
  async triggerSend(input) {
    const selectors = [
      '.message-input-right-button-send button.send-button',
      '.chat-prompt-send-button button.send-button',
      'button.send-button',
      'button[aria-label="Send"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]',
      'button[type="submit"]',
    ];
    const inOverlay = (el) => !!(el && el.closest && el.closest('#tokfree-overlay, [id^="tokfree-"]'));

    // 策略 1：点击"可见"的发送按钮（原生 el.click()，React 受控组件必需）
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (!this.isElementVisible(el) || el.disabled) continue;
          if (inOverlay(el)) continue;
          el.click();
          return true;
        }
      } catch (_) { /* 选择器不合法时跳过 */ }
    }

    // 策略 1b：webview 被遮挡/后台标签时元素无布局 → offsetW/H 全为 0，
    // 上面的"可见"筛选会落空；React 的 onClick 不校验可见性，故对隐藏元素
    // 做一次程序化 el.click()（仍严格排除覆盖层，并排除停止键）。
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (inOverlay(el) || el.disabled) continue;
          const label = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '';
          const cls = typeof el.className === 'string' ? el.className : '';
          // 关键防护：AI 生成中时发送键会换成停止键，绝不能误点中断生成
          if (/停止|stop/i.test(label) || /stop-button/.test(cls)) continue;
          try { el.click(); } catch (_) { continue; }
          console.log('[TokFree] Qwen：已对（可能不可见的）发送按钮执行程序化点击');
          return true;
        }
      } catch (_) { /* 选择器不合法时跳过 */ }
    }

    // 策略 1c：从输入框向上爬容器，找容器内靠后的发送候选（发送键常在输入区右下角）。
    try {
      if (input && input.closest) {
        let box = input;
        for (let up = 0; up < 6 && box && box.parentElement; up++) {
          box = box.parentElement;
          const cands = box.querySelectorAll('button, [role="button"], [class*="send"], [class*="icon-button"]');
          if (!cands || cands.length < 1) continue;
          for (let ci = cands.length - 1; ci >= 0; ci--) {
            const cand = cands[ci];
            if (inOverlay(cand) || cand.disabled) continue;
            const lb = (cand.getAttribute && (cand.getAttribute('aria-label') || cand.getAttribute('title'))) || '';
            const cc = typeof cand.className === 'string' ? cand.className : '';
            if (/停止|stop/i.test(lb) || /stop-button/.test(cc)) continue;
            try { cand.click(); console.log('[TokFree] Qwen：策略1c 相对定位点击发送按钮'); return true; } catch (_) { /* 继续 */ }
          }
        }
      }
    } catch (_) { /* 忽略 */ }

    // 策略 2：主进程原生 Enter 兜底（后台/被遮挡 webview 下合成事件无效，
    // 需 webContents.sendInputEvent 注入真实级按键，主进程会先聚焦再注入）。
    if (window.electronAPI && typeof window.electronAPI.sendEnterToChat === 'function') {
      try {
        await window.electronAPI.sendEnterToChat();
        console.log('[TokFree] Qwen：已请求原生 Enter 发送（sendInputEvent）');
        return true;
      } catch (_) { /* IPC 失败时回退通用逻辑 */ }
    }
    return false;
  },

  // 提取当前用户信息（邮箱/昵称），用于窗口标题（异步：接口优先）
  // 1. localStorage userStore / JWT（历史实现）
  // 2. /api/v1/auths/ 接口（Qwen 新版用户信息接口）
  // 3. DOM 兜底
  async extractUserInfo() {
    // 1. zustand 持久化的 userStore：{state:{user:{...}}}
    try {
      const raw = localStorage.getItem('userStore');
      if (raw) {
        const parsed = JSON.parse(raw);
        const u = (parsed && parsed.state && parsed.state.user) || (parsed && parsed.user);
        const name = u && (u.name || u.nickname || u.username || u.email || u.phone);
        if (name) return String(name).trim();
      }
    } catch (_) { /* 解析失败忽略 */ }

    // 2. token / active_token（JWT payload 里通常带 email 或 sub）
    try {
      const token = localStorage.getItem('token') || localStorage.getItem('active_token');
      if (token && token.split('.').length === 3) {
        const seg = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(decodeURIComponent(escape(atob(seg))));
        const name = payload && (payload.email || payload.name || payload.username || payload.sub);
        if (name) return String(name).trim();
      }
    } catch (_) { /* 解析失败忽略 */ }

    // 3. Qwen 用户信息接口（返回顶层 { name, email, ... }）
    try {
      const r = await fetch('/api/v1/auths/', { credentials: 'include' });
      if (r.ok) {
        const j = await r.json();
        const u = (j && j.user) || j;
        const name = u && (u.name || u.nickname || u.username || u.email);
        if (name) return String(name).trim();
      }
    } catch (_) { /* 接口不可用时忽略 */ }

    // 4. DOM 兜底：侧边栏/设置里的用户名区域
    const domSelectors = [
      '[class*="user-info"] [class*="name"]',
      '[class*="user-name"]',
      '[class*="user-email"]',
      '[class*="userInfo"]',
    ];
    for (const sel of domSelectors) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        const text = (el.textContent || '').trim();
        if (text && text.length <= 60) return text;
      } catch (_) { /* 忽略 */ }
    }
    return '';
  },

  // ========== 登录页检测（供 login-manager 用）==========
  // 千问用「手机号 / 账号」登录，无传统账密表单自动登录链路，
  // 故只提供 isLoginPage / isMainInterface（账密类方法不适用，不实现）。
  // 判断依据：已登录有 button.user-menu-btn（含用户名）/ 头像；未登录有可见"登录/注册"入口。

  // 是否存在「已登录」信号：用户菜单按钮（非"登录"文案）/ 头像。
  __hasLoggedInSignal() {
    try {
      // 1) 用户菜单按钮 button.user-menu-btn（已登录才渲染，内含用户名 / "Free" 等）
      try {
        const menus = document.querySelectorAll('button.user-menu-btn, [class*="user-menu-btn"]');
        for (const el of menus) {
          if (this.__isQwenOverlay(el)) continue;
          if (!this.isElementVisible(el)) continue;
          const t = (el.textContent || '').trim();
          const tl = t.toLowerCase();
          // 若按钮文案即"登录/注册"，说明未登录，不算已登录信号
          if (t === '登录' || t === '注册' || t === '登录注册' || tl === 'sign in' || tl === 'log in') continue;
          return true;
        }
      } catch (_) {}
      // 2) 头像 img[alt] / class 含 avatar 的可见元素
      const avatarSels = [
        'img[alt*="头像"]',
        'img[class*="avatar"]',
        '[class*="avatar"] img',
        '[class*="user-avatar"]',
      ];
      for (const sel of avatarSels) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (this.__isQwenOverlay(el)) continue;
            if (this.isElementVisible(el)) return true;
          }
        } catch (_) {}
      }
      return false;
    } catch (_) { return false; }
  },

  // 是否存在可见的「登录 / 注册」入口（未登录信号）。
  __hasVisibleSignIn() {
    try {
      const cands = document.querySelectorAll('button, a, [role="button"], span, div');
      for (const el of cands) {
        if (this.__isQwenOverlay(el)) continue;
        const t = (el.textContent || '').trim();
        if (!t || t.length > 10) continue;
        const tl = t.toLowerCase();
        if (t !== '登录' && t !== '注册' && t !== '登录注册' && t !== '立即登录' && t !== '登录或注册'
          && tl !== 'sign in' && tl !== 'log in' && tl !== 'sign up') continue;
        if (this.isElementVisible(el)) return true;
      }
      return false;
    } catch (_) { return false; }
  },

  // 当前是否在登录页（未登录）：有可见登录入口 且 无已登录信号。
  isLoginPage() {
    try {
      if (this.__hasLoggedInSignal()) return false;
      if (this.__hasVisibleSignIn()) return true;
      return false;
    } catch (_) { return false; }
  },

  // 是否已进入主界面（已登录）。
  // 优先已登录信号；其次看有无可见登录入口；最后退化为有无输入框。
  isMainInterface() {
    try {
      if (this.__hasLoggedInSignal()) return true;
      if (this.__hasVisibleSignIn()) return false;
      return !!this.findInput();
    } catch (_) { return false; }
  },

  // 首页判断正则（chat.qwen.ai 根路径，或新建会话页）
  homeUrlPattern: /^https:\/\/chat\.qwen\.ai\/(c\/(new-chat|guest))?\/?(\?.*)?$/,

  // 从 URL 提取会话 ID（chat.qwen.ai/c/{id}）
  // 注意：/c/new-chat、/c/guest 等是保留路由，不能当作会话 ID
  extractSessionId(url) {
    if (!url) return null;
    const match = url.match(/\/c\/([a-zA-Z0-9_-]+)/i);
    if (!match) return null;
    const id = match[1];
    if (RESERVED_SEGMENTS.indexOf(id.toLowerCase()) !== -1) return null;
    return id;
  },

  // 判断 URL 是否属于本平台
  matchesUrl(url) {
    if (!url) return false;
    return url.includes('chat.qwen.ai');
  },

  // ========== 自动解析相关方法 ==========

  // 是否正在生成中（生成中会被替换为 button.stop-button）
  isGenerating() {
    // 多策略：平台特有 class 优先 → 语义属性 → 宽 class 兜底，命中可见元素即视为生成中。
    const selectors = [
      'button.stop-button',
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
  // 生成中：button.stop-button 存在；生成结束：按钮消失，取「存在→消失」的边沿
  async isResponseComplete() {
    const stopBtn = document.querySelector('button.stop-button');
    const visible = !!stopBtn;
    const now = Date.now();

    if (visible) {
      if (!stopBtnVisible) stopBtnFirstSeen = now;
      stopBtnVisible = true;
      return false;
    }

    if (stopBtnVisible) {
      stopBtnVisible = false;
      const generatingMs = now - stopBtnFirstSeen;
      if (generatingMs < MIN_GENERATING_MS) {
        // 生成态过短：发送/停止按钮的瞬时切换，忽略，避免误判完成
        console.log('[' + new Date().toISOString() + '] [TokFree] Qwen 停止按钮仅存在 ' +
          generatingMs + 'ms（<' + MIN_GENERATING_MS + 'ms），忽略本次完成信号');
        return false;
      }
      console.log('[' + new Date().toISOString() + '] [TokFree] Qwen 回复完成，等待 500ms 后解析');
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log('[' + new Date().toISOString() + '] [TokFree] Qwen 500ms 等待结束');
      return true;
    }

    return false;
  },

  // 获取当前页面所有 AI 消息容器（排除用户消息）
  getMessageCandidates() {
    const list = document.querySelectorAll('.qwen-chat-message-assistant');
    if (list && list.length > 0) {
      return Array.from(list).filter(el => !this.isUserMessage(el));
    }
    return Array.from(document.querySelectorAll('[class*="qwen-chat-message"]'))
      .filter(el => !this.isUserMessage(el));
  },

  // 从消息容器中取回复内容根节点
  getMessageMarkdown(messageEl) {
    if (!messageEl) return null;
    return messageEl.querySelector('.qwen-markdown') ||
      messageEl.querySelector('[class*="markdown"]') ||
      messageEl;
  },

  // 判断节点是否位于用户消息区域内
  // 仅依赖 DOM 结构信号（class / data-role / data-author / 语义属性），
  // 不再硬编码任何提示词文本，避免因提示词改版而失效。
  isUserMessage(node) {
    if (!node) return false;
    let current = node;
    while (current) {
      // 1) class 语义：qwen-chat-message-user / 含 user 的 message 容器
      const cls = typeof current.className === 'string' ? current.className : '';
      if (cls) {
        if (/(^|\s)qwen-chat-message-user(\s|$)/.test(cls)) return true;
        if (/qwen-chat-message[-_]user/i.test(cls)) return true;
      }
      // 2) data-role / data-author 语义属性
      const role = (current.getAttribute && (
        current.getAttribute('data-role') ||
        current.getAttribute('data-author') ||
        current.getAttribute('data-message-author-role') ||
        current.getAttribute('data-message-role')
      )) || '';
      if (role === 'user' || role === 'human') return true;
      // 3) aria-label 兜底
      const aria = (current.getAttribute && current.getAttribute('aria-label')) || '';
      if (/^user$/i.test(aria) || /用户|you/i.test(aria)) {
        // 仅当该节点自身带消息容器语义时才采信，避免命中外层无关容器
        if (cls && /message|chat/i.test(cls)) return true;
      }
      current = current.parentElement;
    }
    // 4) 结构兜底：向上查找最近的 qwen-chat-message 容器，看其角色 class 后缀
    let root = node;
    while (root) {
      const c = typeof root.className === 'string' ? root.className : '';
      if (/qwen-chat-message(\s|$)/.test(c) || /qwen-chat-message-/.test(c)) {
        return /qwen-chat-message[-_]user/i.test(c);
      }
      root = root.parentElement;
    }
    return false;
  },

  // 提取代码块的语言标记（小写）
  // Qwen 的语言标签渲染在 .qwen-markdown-code-header 的第一个子节点里，
  // 部分渲染路径下也保留 code[class*="language-"]，两种都兼容。
  getCodeBlockLanguage(pre) {
    if (!pre) return '';

    // 1. class 里的 language-xxx
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

    // 2. 代码块头部文本：真机 header 首个子节点常为空 div（语言标签在其它位置），
    //    故遍历 header 内所有叶子节点，取第一个形如语言标签的纯文本；
    //    旧结构 / 单测 mock 无 querySelectorAll 时回退 firstElementChild。
    try {
      const header = pre.querySelector('.qwen-markdown-code-header');
      if (header) {
        const texts = [];
        if (typeof header.querySelectorAll === 'function') {
          for (const el of header.querySelectorAll('*')) {
            if (el.children && el.children.length === 0) {
              const t = (el.textContent || '').trim();
              if (t) texts.push(t);
            }
          }
        }
        if (texts.length === 0) {
          const fe = header.firstElementChild;
          const t = ((fe && fe.textContent) || header.textContent || '').trim();
          if (t) texts.push(t);
        }
        for (const t of texts) {
          if (/^[a-zA-Z0-9_+#.-]{1,20}$/.test(t) && !/^(copy|download|run|复制|下载)$/i.test(t)) {
            return t.toLowerCase();
          }
        }
      }
    } catch (_) { /* 忽略 */ }

    // 3. 外层容器 class（如 qwen-markdown-code-body-streaming tokfree）
    try {
      const wrapper = pre.closest('.qwen-markdown-code-body');
      const cls = wrapper ? (wrapper.className || '') : (pre.className || '');
      if (typeof cls === 'string') {
        const parts = cls.split(/\s+/);
        for (const p of parts) {
          if (!p || p.indexOf('qwen-') === 0) continue;
          if (/^[a-zA-Z0-9_+#.-]{1,20}$/.test(p) && p !== 'streaming') return p.toLowerCase();
        }
      }
    } catch (_) { /* 忽略 */ }

    return '';
  },

  // ========== 深度思考（Deep Think）开关：检测与切换 ==========
  // Qwen3 的「深度思考」是输入框附近的一枚可切换按钮（文案「深度思考」/「Deep thinking」/「思考」）。
  // ⚠️ 真机探测：chat.qwen.ai 各版本 DOM 结构差异较大，且未登录时可能无此按钮。
  //    当前实现以「输入框附近文案 + aria-pressed/aria-checked + class 含 active/selected」多策略兜底，
  //    并严格排除 TokFree 覆盖层元素（防误命中覆盖层按钮）。
  // 已知限制：需真机登录态确认 —— chat.qwen.ai 各版本 DOM 差异大且未登录时可能无此按钮，
  //   本环境无有效登录态，无法采集真实选择器/文案，故不臆造；保留上述多策略容错。
  //   若后续拿到真机 DOM，优先把专属 class/data-testid 补入下方 attrSelectors。

  // 排除 TokFree 覆盖层元素（覆盖层按钮也含中文文案，不排除会误命中）
  __isQwenOverlay(el) {
    try {
      if (!el || typeof el.closest !== 'function') return false;
      return !!el.closest('#tokfree-overlay, #tokfree-window-manager, #tokfree-settings-drawer, [id^="tokfree-"]');
    } catch (_) { return false; }
  },

  // 在输入框附近容器内按文案查找可点击开关的通用实现
  // @param {RegExp} textRe 匹配开关文案的正则
  // @param {string[]} attrSelectors 文案无法命中时的属性兜底选择器
  __findToggleByText(textRe, attrSelectors) {
    try {
      let root = document;
      try {
        const input = this.findInput ? this.findInput() : null;
        if (input && input.closest) {
          let box = input;
          let scope = null;
          for (let up = 0; up < 6 && box && box.parentElement; up++) {
            box = box.parentElement;
            if (this.__isQwenOverlay(box)) break;
            if (box.querySelector('button, [role="button"]')) scope = box;
          }
          if (scope) root = scope;
        }
      } catch (_) {}

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
      const cands = root.querySelectorAll('button, [role="button"], span');
      let best = null;
      for (const el of cands) {
        if (this.__isQwenOverlay(el)) continue;
        if (!this.isElementVisible(el)) continue;
        const t = (el.textContent || '').trim();
        if (!t || t.length > 24) continue;
        if (!textRe.test(t)) continue;
        if (!best || t.length < (best.textContent || '').trim().length) best = el;
      }
      if (best) {
        if (isClickable(best)) return best;
        let up = best;
        for (let i = 0; i < 3 && up && up.parentElement; i++) {
          const p = up.parentElement;
          if (this.__isQwenOverlay(p)) break;
          if (isClickable(p)) return p;
          up = p;
        }
        return best;
      }

      for (const sel of attrSelectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (this.__isQwenOverlay(el)) continue;
            if (!this.isElementVisible(el)) continue;
            return el;
          }
        } catch (_) {}
      }
      return null;
    } catch (_) { return null; }
  },

  // 通用：读取开关按钮的开启态
  __readToggleOn(btn) {
    try {
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

  // 查找「深度思考」开关按钮元素；找不到返回 null
  getDeepThinkButton() {
    // 文案：深度思考 / DeepThink / Deep Think / 思考
    return this.__findToggleByText(
      /深度思考|Deep\s?Think|深度思考\(R1\)|^思考$/i,
      [
        '[aria-pressed][class*="deep"]',
        '[aria-pressed][class*="think"]',
        '[class*="deepThink"]',
        '[class*="deep-think"]',
        '[class*="deep"][role="button"]',
        '[class*="think"][role="button"]',
        '[data-testid*="deep"]',
        '[data-testid*="think"]',
      ]
    );
  },

  // 深度思考按钮是否处于「开启」态（容错；找不到按钮返回 false）
  isDeepThinkOn() {
    return this.__readToggleOn(this.getDeepThinkButton());
  },

  // 把深度思考切到目标状态（已是目标态则不动）
  // @returns {{ok:boolean, changed:boolean, available:boolean, error?:string}}
  setDeepThink(on) {
    try {
      const btn = this.getDeepThinkButton();
      if (!btn) return { ok: false, changed: false, available: false };
      const want = !!on;
      if (this.isDeepThinkOn() === want) return { ok: true, changed: false, available: true };
      // Qwen 为 React 站点，必须用原生 el.click()
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

  // ========== 联网搜索（Web Search）开关：检测与切换 ==========
  // Qwen3 的「联网搜索」同为输入框附近的可切换按钮（文案「联网搜索」/「Web search」/「搜索」）。
  // 已知限制：需真机登录态确认 —— chat.qwen.ai 各版本 DOM 差异大且未登录时可能无此按钮，
  //   本环境无有效登录态，无法采集真实选择器/文案，故不臆造；保留上述多策略容错。
  //   若后续拿到真机 DOM，优先把专属 class/data-testid 补入下方 attrSelectors。

  // 查找「联网搜索」开关按钮元素；找不到返回 null
  getWebSearchButton() {
    return this.__findToggleByText(
      /联网搜索|Web\s?Search|联网|^搜索$/i,
      [
        '[aria-pressed][class*="web"]',
        '[aria-pressed][class*="search"]',
        '[class*="webSearch"]',
        '[class*="web-search"]',
        '[class*="search"][role="button"]',
        '[data-testid*="web"]',
        '[data-testid*="search"]',
      ]
    );
  },

  // 联网搜索按钮是否处于「开启」态（容错；找不到按钮返回 false）
  isWebSearchOn() {
    return this.__readToggleOn(this.getWebSearchButton());
  },

  // 把联网搜索切到目标状态（已是目标态则不动）
  // @returns {{ok:boolean, changed:boolean, available:boolean, error?:string}}
  setWebSearch(on) {
    try {
      const btn = this.getWebSearchButton();
      if (!btn) return { ok: false, changed: false, available: false };
      const want = !!on;
      if (this.isWebSearchOn() === want) return { ok: true, changed: false, available: true };
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

  // ========== 模式切换（生成图像 / 绘画）==========
  // 真机确认（chat.qwen.ai 2026-09）：千问输入框附近有 div.mode-select-open[aria-label="选择模式"]（role=button），
  //   点开是下拉 div.mode-select-dropdown-item 列表，含：上传附件 / Agent模式Beta / 生成图像 / 创建视频 /
  //   网页搜索 / 深入研究 / 网页开发 / 更多 / 工具。
  //   点「生成图像」即进入 Qwen-Image 2.0 绘画模式。说明千问网页版原生支持绘画。

  // 查找「选择模式」触发器元素（div.mode-select-open[aria-label="选择模式"]）；找不到返回 null
  getModeSelectTrigger() {
    try {
      const selectors = [
        'div.mode-select-open[aria-label="选择模式"]',
        '.mode-select-open[aria-label="选择模式"]',
        'div.mode-select-open[aria-label*="模式"]',
        '[class*="mode-select-open"][aria-label*="选择模式"]',
        '[class*="mode-select"][role="button"]',
        '.mode-select-open',
      ];
      for (const sel of selectors) {
        let els;
        try { els = document.querySelectorAll(sel); } catch (_) { continue; }
        for (const el of els) {
          if (this.__isQwenOverlay(el)) continue;
          return el;
        }
      }
      return null;
    } catch (_) { return null; }
  },

  // 切换到「生成图像」（绘画）模式。
  // 流程：点开 mode-select-open → 在下拉 mode-select-dropdown-item 中找文案含「生成图像」的项 → 原生 click()。
  // 多策略容错：找不到触发器/下拉项一律安全返回，绝不抛错。
  // @returns {{ok:boolean, changed:boolean, available:boolean, error?:string}}
  openImageMode() {
    try {
      const trigger = this.getModeSelectTrigger();
      if (!trigger) return { ok: false, changed: false, available: false };

      // 已是图像模式则不重复操作
      if (this.isImageMode()) return { ok: true, changed: false, available: true };

      // 打开下拉（React 站点用原生 click）
      try { trigger.click(); } catch (_) {
        return { ok: false, changed: false, available: true, error: 'trigger click failed' };
      }

      // 在下拉项里找「生成图像」（React 下拉通常同步渲染，直接同步查找；找不到则安全返回）
      const findItem = () => {
        const itemSelectors = [
          'div.mode-select-dropdown-item',
          '.mode-select-dropdown-item',
          '[class*="mode-select-dropdown-item"]',
          '[class*="dropdown-item"]',
        ];
        for (const sel of itemSelectors) {
          let items;
          try { items = document.querySelectorAll(sel); } catch (_) { continue; }
          for (const it of items) {
            if (this.__isQwenOverlay(it)) continue;
            const t = (it.textContent || '').trim();
            if (t && /生成图像|图像生成|生成图片|绘画|image/i.test(t)) return it;
          }
        }
        return null;
      };

      const item = findItem();
      if (!item) return { ok: false, changed: false, available: true, error: 'image option not found' };
      try { item.click(); } catch (_) {
        return { ok: false, changed: false, available: true, error: 'item click failed' };
      }
      return { ok: true, changed: true, available: true };
    } catch (err) {
      return { ok: false, changed: false, error: (err && err.message) || String(err) };
    }
  },

  // 判断当前是否处于图像（绘画）模式。
  // 信号：body/html 含 Qwen-Image 文案、模式触发器文案含「生成图像」、输入框 placeholder 变化；
  //   均找不到时返回 false（容错）。
  isImageMode() {
    try {
      // 1) 模式触发器自身文案回显当前模式
      const trigger = this.getModeSelectTrigger();
      if (trigger) {
        const t = (trigger.textContent || '').trim();
        if (t && /生成图像|图像生成|生成图片|绘画|image/i.test(t)) return true;
      }
      // 2) 页面出现 Qwen-Image 品牌/模式标识
      try {
        if (/Qwen[-\s]?Image/i.test(document.body && document.body.textContent || '')) return true;
      } catch (_) {}
      // 3) 输入框 placeholder 变化（图像模式常改为描述生成图片的提示）
      try {
        const input = this.findInput ? this.findInput() : null;
        if (input) {
          const ph = (input.getAttribute && (input.getAttribute('placeholder') || input.getAttribute('data-placeholder'))) || '';
          if (ph && /生成图片|描述.*图像|生成图像|image/i.test(ph)) return true;
        }
      } catch (_) {}
      return false;
    } catch (_) { return false; }
  },
};
