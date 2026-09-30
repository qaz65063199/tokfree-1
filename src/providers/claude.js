/**
 * Claude Provider 定义
 * 基于 claude.ai 页面结构，输入框为 ProseMirror（contenteditable）。
 */
let stopBtnVisible = false;

module.exports = {
  id: 'claude',
  name: 'Claude',
  // 使用网络请求拦截方式获取 AI 回复（替代 DOM 抓取）
  useIntercept: true,
  homeUrl: 'https://claude.ai/new',
  sessionUrlBase: 'https://claude.ai/chat/',

  // 判断元素是否可见（offsetWidth/offsetHeight > 0）
  isElementVisible(el) {
    if (!el) return false;
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  },

  // 查找可见的聊天输入框（Claude 用 ProseMirror contenteditable）
  // ⚠️ 排除 TokFree 覆盖层内的输入框（否则兜底 'textarea' 会命中覆盖层"补充说明"框）
  findInput() {
    const selectors = [
      'div[role="textbox"].tiptap',
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
      'button[aria-label="Send message"]',
      '[data-testid="chat-input-send"]',
      'button[aria-label*="send"]',
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

  // 提取当前用户信息文本（左下角账号名）
  extractUserInfo() {
    const el = document.querySelector('.df-user-menu-btn span.whitespace-nowrap.text-secondary');
    return el ? el.textContent.trim() : '';
  },

  // 首页判断正则（https://claude.ai/new 或 https://claude.ai/）
  homeUrlPattern: /^https:\/\/claude\.ai(\/new)?\/?(\?.*)?$/,

  // 从 URL 提取会话 ID（Claude 是 /chat/xxx 格式）
  extractSessionId(url) {
    if (!url) return null;
    const match = url.match(/\/chat\/([a-zA-Z0-9_-]+)/i);
    if (match) return match[1];
    return null;
  },

  // 判断 URL 是否属于本平台
  matchesUrl(url) {
    return url.includes('claude.ai');
  },

  // ========== 自动解析相关方法 ==========

  // 是否正在生成中（停止按钮存在 → 运行中）
  isGenerating() {
    // 多策略：精确 aria-label 优先 → 语义属性 → 宽 class 兜底，命中可见元素即视为生成中。
    const selectors = [
      'button[aria-label="Stop response"]',
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
  // 回答中：button[aria-label="Stop response"] 存在
  // 回答完成：该按钮消失；从存在到消失的边沿才返回 true，避免持续触发
  async isResponseComplete() {
    const stopBtn = document.querySelector('button[aria-label="Stop response"]');
    const visible = !!stopBtn;

    if (visible) {
      stopBtnVisible = true;
      return false;
    }

    // 上一次可见、本次不可见 → 回答刚结束
    if (stopBtnVisible) {
      stopBtnVisible = false;
      console.log('[' + new Date().toISOString() + '] [TokFree] Claude 回复完成，等待 500ms 后解析');
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log('[' + new Date().toISOString() + '] [TokFree] Claude 500ms 等待结束');
      return true;
    }

    return false;
  },

  // 获取当前页面所有 AI 消息容器（排除用户消息）
  getMessageCandidates() {
    return Array.from(document.querySelectorAll('[class*="message-row"]')).filter(el => !this.isUserMessage(el));
  },

  // 从消息容器中取回复内容根节点
  getMessageMarkdown(messageEl) {
    return messageEl.querySelector('[class*="standard-markdown"]') ||
      messageEl.querySelector('div[class*="prose"]') ||
      messageEl;
  },

  // 判断节点是否位于用户消息区域内
  isUserMessage(node) {
    let current = node;
    while (current) {
      const testid = current.getAttribute?.('data-testid') || '';
      if (testid === 'user-message') return true;
      const role = current.getAttribute?.('data-role') || current.getAttribute?.('data-author') || '';
      if (role === 'user' || role === 'human') return true;
      current = current.parentElement;
    }
    const rowEl = node && node.closest ? node.closest('[class*="message-row"]') : null;
    if (rowEl && rowEl.querySelector('[data-testid="user-message"]')) return true;
    const text = (node.textContent || node.innerText || '').substring(0, 200);
    return text.includes('我已选择目录：') || text.includes('系统提示词：') || text.includes('工具使用规则：');
  },

  // 提取代码块的语言标记（Claude 使用 code[class*="language-"]）
  getCodeBlockLanguage(pre) {
    if (!pre) return '';
    const codeEl = pre.querySelector('code');
    const els = [codeEl, pre].filter(Boolean);
    for (const el of els) {
      const cls = el.className || '';
      if (typeof cls === 'string') {
        const langMatch = cls.match(/language-([\w-]+)/);
        if (langMatch) return langMatch[1].toLowerCase();
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
  // ⚠️ Claude 采用「邮箱 → magic link」登录，【没有密码框】，
  //    故此处只做「是否登录」判断，不实现账密表单方法（findPasswordInput 等不适用）。
  // 未登录页有 "Continue with Google/Apple/email/SSO" 等可见入口；登录后左下角显示账号菜单。

  // 是否存在「已登录」信号：左下角账号/用户菜单。
  __hasLoggedInSignal() {
    try {
      const sels = [
        '.df-user-menu-btn',
        '[data-testid="user-menu-button"]',
        'button[aria-label*="account" i]',
        'button[aria-label*="profile" i]',
        'button[aria-label*="settings" i]',
        'button[aria-label*="账号" i]',
        'button[aria-label*="设置" i]',
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

  // 是否存在可见的「登录 / Continue with ...」入口。
  __hasVisibleSignIn() {
    try {
      const btns = document.querySelectorAll('a, button, [role="button"]');
      for (const b of btns) {
        if (this.__isTokFreeOverlay(b)) continue;
        const t = (b.textContent || '').trim();
        const al = (b.getAttribute('aria-label') || '').trim();
        // 文案匹配：Continue with Google/Apple/email/SSO、Sign in/Log in、登录/注册
        const isSignInText = /^(continue with|sign in|log in|sign up|登录|注册)/i.test(t) ||
          /^(continue with|sign in|log in|sign up)/i.test(al);
        if (isSignInText && this.isElementVisible(b)) return true;
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
  // 优先看已登录信号（账号菜单）；无该信号时退化为
  // 「有可见输入框 且 无可见登录入口」。
  isMainInterface() {
    try {
      if (this.__hasLoggedInSignal()) return true;
      if (this.__hasVisibleSignIn()) return false;     // 有登录入口 = 未登录
      return !!this.findInput();
    } catch (_) { return false; }
  },

  // 查找「深度思考 / 扩展思考（Extended Thinking）」开关按钮元素；找不到返回 null
  // ⚠️ 骨架实现（选择器待真机确认）：Claude 的 Extended Thinking 入口随版本变化、
  //    且未登录态无法采集真实 DOM，故用多策略容错：
  //    ① 输入框附近容器内按文案/aria-label 匹配 thinking/思考/extended/reasoning；② 属性/data-testid 兜底。
  //    拿到真机 DOM 后，优先把专属 class/data-testid 补入下方 attrSelectors。
  getDeepThinkButton() {
    try {
      // ⭐ 首选（真机确认）：Claude 的思考强度由「模型菜单里的 Effort」控制，
      //   不是独立开关。模型选择器按钮 = button[aria-label*="Model:"]（如
      //   "Model: Sonnet 5 Medium"）；点开后有 [role="menuitem"] 含 "Effort Medium"。
      //   此处先返回该模型选择器按钮作为「深度思考入口」锚点；
      //   完整的 Effort 切换（点开菜单→选 Effort 项）待后续细化。
      try {
        const sels = ['button[aria-label*="Model:"]', 'button[aria-label*="模型"]'];
        for (const sel of sels) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (this.__isTokFreeOverlay(el)) continue;
            if (!this.isElementVisible(el)) continue;
            return el;
          }
        }
      } catch (_) {}

      const textRe = /thinking|思考|extended|扩展|reasoning|推理/i;
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
        '[aria-pressed][class*="extend"]',
        '[class*="thinking"][role="button"]',
        '[class*="extended"][role="button"]',
        '[data-testid*="thinking"]',
        '[data-testid*="extended"]',
        '[data-testid*="reasoning"]',
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
      // Claude 为 React 站点，必须用原生 el.click()（鼠标事件序列无效）
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

  // ========== Effort 档位（Claude 的思考强度控制）==========
  // 真机路径：模型菜单按钮 button[aria-label*="Model:"] → 菜单 [role="menuitem"]（文案 "Effort ..."）
  // → 档位子菜单 5 个 [role="menuitemradio"]：Low/Medium(Default)/High/Extra/Max。
  // 当前档位由 aria-checked="true" 标识。全部 try/catch 容错，找不到返回保守值，绝不抛错。

  // 内部：小睡眠（等待菜单渲染）
  __sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  },

  // 内部：React 站点原生点击
  __nativeClick(el) {
    try { el.click(); return true; } catch (_) { return false; }
  },

  // 内部：查找模型选择器按钮（Effort 入口锚点）
  __findModelButton() {
    try {
      const sels = ['button[aria-label*="Model:"]', 'button[aria-label*="模型"]'];
      for (const sel of sels) {
        let els;
        try { els = document.querySelectorAll(sel); } catch (_) { continue; }
        for (const el of els) {
          if (this.__isTokFreeOverlay(el)) continue;
          if (!this.isElementVisible(el)) continue;
          return el;
        }
      }
    } catch (_) {}
    return null;
  },

  // 内部：在当前已打开的菜单里查找文案以 "Effort" 开头的 [role="menuitem"]
  __findEffortMenuItem() {
    try {
      const items = document.querySelectorAll('[role="menuitem"]');
      for (const it of items) {
        if (this.__isTokFreeOverlay(it)) continue;
        const t = (it.textContent || '').trim();
        if (/^Effort/i.test(t)) return it;
      }
    } catch (_) {}
    return null;
  },

  // 内部：在已展开的档位子菜单里按名称匹配 [role="menuitemradio"]（大小写不敏感）
  __findLevelRadio(level) {
    try {
      const want = String(level || '').trim().toLowerCase();
      if (!want) return null;
      const radios = document.querySelectorAll('[role="menuitemradio"]');
      for (const r of radios) {
        if (this.__isTokFreeOverlay(r)) continue;
        const t = (r.textContent || '').trim().toLowerCase();
        const head = t.split(/[\s(（]/)[0];
        if (t.startsWith(want) || head === want) return r;
      }
    } catch (_) {}
    return null;
  },

  // 打开模型菜单并返回 "Effort" 菜单项元素；找不到返回 null。
  // 若菜单已打开（Effort 项已在）则直接返回，避免误触切换关闭。
  async getEffortButton() {
    try {
      let item = this.__findEffortMenuItem();
      if (item) return item;
      const modelBtn = this.__findModelButton();
      if (!modelBtn) return null;
      this.__nativeClick(modelBtn);
      for (let i = 0; i < 12; i++) {
        await this.__sleep(50);
        item = this.__findEffortMenuItem();
        if (item) return item;
      }
      return null;
    } catch (_) { return null; }
  },

  // 返回当前 Effort 档位文案（读 aria-checked="true" 的 menuitemradio，如 "Medium"）。
  // 需子菜单已展开；找不到返回 null。
  getEffortLevel() {
    try {
      const radios = document.querySelectorAll('[role="menuitemradio"]');
      for (const r of radios) {
        if (this.__isTokFreeOverlay(r)) continue;
        const ac = r.getAttribute && r.getAttribute('aria-checked');
        if (ac === 'true') {
          const t = (r.textContent || '').trim();
          const m = t.match(/^(Low|Medium|High|Extra|Max)/i);
          return m ? m[1] : t;
        }
      }
      return null;
    } catch (_) { return null; }
  },

  // 切换到目标 Effort 档位（Low/Medium/High/Extra/Max，大小写不敏感）。
  // @returns {{ok:boolean, changed:boolean, available:boolean, error?:string}}
  async setEffort(level) {
    try {
      const want = String(level || '').trim();
      if (!want) return { ok: false, changed: false, available: false };
      const effortItem = await this.getEffortButton();
      if (!effortItem) return { ok: false, changed: false, available: false };
      // 展开档位子菜单
      this.__nativeClick(effortItem);
      let target = null;
      for (let i = 0; i < 12; i++) {
        await this.__sleep(50);
        target = this.__findLevelRadio(want);
        if (target) break;
      }
      if (!target) return { ok: false, changed: false, available: false };
      const ac = target.getAttribute && target.getAttribute('aria-checked');
      if (ac === 'true') return { ok: true, changed: false, available: true };
      this.__nativeClick(target);
      return { ok: true, changed: true, available: true };
    } catch (err) {
      return { ok: false, changed: false, error: (err && err.message) || String(err) };
    }
  },
};
