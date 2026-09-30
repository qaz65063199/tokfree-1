/**
 * DeepSeek Provider 定义
 * 包含主进程和 preload 都需要的信息：
 * - 主进程：homeUrl（打开窗口）、sessionUrlBase（导航到会话）
 * - preload：输入框/发送按钮选择器、用户信息选择器、首页判断正则
 * - preload：自动解析相关方法（完成检测/消息定位/语言提取等）
 */
const STOP_BTN_SELECTOR =
  '.ds-button.ds-button--primary.ds-button--filled.ds-button--circle.ds-button--m' +
  '.ds-button--icon-relative-m.ds-button--disabled';

const ACTION_BTN_SELECTOR =
  '[role="button"].ds-button--iconLabelTertiary';

module.exports = {
  id: 'deepseek',
  name: 'DeepSeek',
  // 使用网络请求拦截方式获取 AI 回复（替代 DOM 抓取）
  useIntercept: true,
  // 支持"全自动上下文压缩"（IndexedDB 读全量消息 + share API 生成分享 + 跳转新会话续接）
  // 其他平台未实现，将退化为"通用压缩"（compaction.js 按此能力分派）
  supportsFullCompaction: true,
  homeUrl: 'https://chat.deepseek.com/',
  sessionUrlBase: 'https://chat.deepseek.com/a/chat/s/',

  // 查找可见的聊天输入框
  // ⚠️ 必须排除 TokFree 覆盖层内的输入框（#tokfree-user-input 等），
  // 否则兜底选择器 'textarea' 会命中覆盖层的"补充说明"框，回执填错框发不出去。
  findInput() {
    const selectors = [
      'textarea[placeholder*="message"]',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="输入"]',
      'textarea[placeholder*="输入消息"]',
      'textarea[placeholder*="ask"]',
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="提问"]',
      'textarea[placeholder*="发送"]',
      'textarea[placeholder*="send"]',
      'textarea[placeholder*="deepseek"]',
      'textarea[placeholder*="DeepSeek"]',
      'textarea.chat-input',
      'textarea',
      'div[contenteditable="true"]',
      '[role="textbox"]',
    ];
    const inOverlay = (el) => {
      try {
        if (!el || typeof el.closest !== 'function') return false;
        return !!el.closest('#tokfree-overlay, #tokfree-window-manager, #tokfree-account-pool, #tokfree-knowledge-panel, #tokfree-mcp-panel, [id^="tokfree-"]');
      } catch (_) { return false; }
    };
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (inOverlay(el)) continue;
          if (this.isElementVisible(el)) return el;
        }
      } catch (_) {}
    }
    return null;
  },

  // 查找可见且未禁用的发送按钮
  findSendButton() {
    const selectors = [
      'div[role="button"][aria-label*="send"]',
      'div[role="button"][aria-label*="发送"]',
      'div[role="button"][data-testid="send-button"]',
      '[data-testid="send-button"]',
      'div[role="button"].ds-icon-button',
      '.ds-icon-button',
      'button[type="submit"]',
      'button[aria-label*="send"]',
      'button[aria-label*="发送"]',
      'button[title*="send"]',
      'button[title*="发送"]',
      'button[data-action="send"]',
      'button[data-type="send"]',
      '.send-btn',
      '.submit-btn',
      'button svg[data-icon="send"]',
      '[data-testid="send"]',
      '[data-testid="send-button"]',
      'button:has(svg[data-icon="arrow"])',
      'button:has(> svg)',
      'button:has(svg[data-icon="send"])',
    ];
    for (const sel of selectors) {
      try {
        const btns = document.querySelectorAll(sel);
        for (const btn of btns) {
          if (!this.isElementVisible(btn) || btn.disabled) continue;
          // ⚠️ 排除 TokFree 覆盖层按钮：button[title*="发送"] 等选择器会命中
          // 覆盖层的「卡住了？点我」按钮（title 含"发送"），点击会误触发催促、
          // 导致真正的回执/唤醒语发不出去。
          if (btn.closest && btn.closest('#tokfree-overlay, #tokfree-root, [id^="tokfree-"]')) continue;
          return btn;
        }
      } catch (_) {}
    }
    return null;
  },

  // 站点原生发送：DeepSeek 的发送按钮并非 <button>，而是 div[role="button"] 结构，
  // 故不能用 findSendButton 的 button[...] 选择器。这里多策略兜底，任一成功即返回 true。
  // chat-input.js 的 triggerSend 会优先调用本方法；返回 true 即视为已发送。
  async triggerSend(input) {
    const selectors = [
      'div[role="button"][aria-label*="send"]',
      'div[role="button"][aria-label*="Send"]',
      'div[role="button"][aria-label*="发送"]',
      'button[aria-label*="send"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]',
      '[data-testid="send-button"]',
      '[data-testid="send"]',
      'div[role="button"].ds-icon-button',
      '.ds-icon-button',
      'button[type="submit"]',
    ];
    const inOverlay = (el) => !!(el && el.closest && el.closest('#tokfree-overlay, #tokfree-root, [id^="tokfree-"]'));
    // 策略1：优先点击"可见"的发送按钮
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (!this.isElementVisible(el)) continue;
          if (inOverlay(el)) continue; // 排除 TokFree 覆盖层按钮，避免误触「卡住了？点我」
          // DeepSeek 等 React 站点必须用原生 el.click()，鼠标事件序列无效
          el.click();
          return true;
        }
      } catch (_) {}
    }
    // 策略1b：webview 被 #chat-view 遮住 / 处于后台标签（display:none）时，
    // 页面元素失去布局 → offsetWidth/offsetHeight 全为 0 → 上面的"可见"筛选全部落空。
    // 此时对隐藏元素做【程序化 el.click()】依然有效（React 的 onClick 不校验可见性），
    // 故这里做一次"忽略可见性"的兜底点击（仍严格排除覆盖层按钮）。
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (inOverlay(el)) continue;
          // 排除 disabled / 明确的空态按钮
          if (el.disabled) continue;
          // ⚠️ 关键防护：AI 正在生成时，DeepSeek 把发送键换成「停止」按钮，
          //    二者可能共用 .ds-icon-button 类。绝不能误点停止键中断生成。
          const label = ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '');
          if (/停止|stop/i.test(label)) continue;
          try { el.click(); } catch (_) { continue; }
          console.log('[TokFree] DeepSeek：已对（可能不可见的）发送按钮执行程序化点击');
          return true;
        }
      } catch (_) {}
    }
    // 策略1c：从输入框向上爬容器，找容器内最后一个可点击的发送候选（DeepSeek 发送键常与输入框同容器）。
    try {
      if (input && input.closest) {
        var box = input;
        for (var up = 0; up < 6 && box && box.parentElement; up++) {
          box = box.parentElement;
          var cands = box.querySelectorAll("button, [role=\"button\"], [class*=\"icon-button\"], [class*=\"send\"]");
          if (!cands || cands.length < 1) continue;
          // 从后往前找：发送键通常在输入区右下角（靠后）
          for (var ci = cands.length - 1; ci >= 0; ci--) {
            var cand = cands[ci];
            if (inOverlay(cand)) continue;
            if (cand.disabled) continue;
            var lb = ((cand.getAttribute && (cand.getAttribute("aria-label") || cand.getAttribute("title"))) || "");
            if (/停止|stop/i.test(lb)) continue;
            try { cand.click(); console.log("[TokFree] DeepSeek：策略1c 相对定位点击发送按钮"); return true; } catch (_) {}
          }
        }
      }
    } catch (_) {}
    // 策略2：兜底原生 Enter —— DeepSeek 是 React 站点，忽略合成按键事件，
    // 改用主进程 sendInputEvent 注入真实级按键（与智谱一致，已验证有效）。
    // 主进程会先聚焦目标 webContents / 宿主窗口，确保隐藏 webview 下按键也能送达。
    if (window.electronAPI && typeof window.electronAPI.sendEnterToChat === 'function') {
      try {
        await window.electronAPI.sendEnterToChat();
        return true;
      } catch (_) { /* IPC 失败时回退通用逻辑 */ }
    }
    return false;
  },

  // ========== 深度思考（DeepThink / R1）开关：检测与切换 ==========
  // 深度思考是输入框附近的一枚可切换胶囊按钮（文案「深度思考」/「深度思考(R1)」）。
  // 各版本 DOM 结构差异较大，故多策略容错：找不到按钮一律返回 null / false / {ok:false}，绝不抛错。
  // ⚠️ 真机探测（chat.deepseek.com）：未登录时页面无此按钮，需登录后确认具体 class。
  //    当前实现以「输入框附近文案 + aria-pressed/aria-checked + class 含 active/selected」多策略兜底，
  //    并严格排除 TokFree 覆盖层元素（防误命中覆盖层按钮）。

  // 排除 TokFree 覆盖层元素（覆盖层按钮也含中文文案，不排除会误命中）
  __isTokFreeOverlay(el) {
    try {
      if (!el || typeof el.closest !== 'function') return false;
      return !!el.closest('#tokfree-overlay, #tokfree-window-manager, #tokfree-settings-drawer, [id^="tokfree-"]');
    } catch (_) { return false; }
  },

  // 查找「深度思考」开关按钮元素；找不到返回 null
  getDeepThinkButton() {
    try {
      // 策略1：限定在「输入框附近的容器」内按文案查找（避免命中 AI 回复正文里的「深度思考」字样）
      let root = document;
      try {
        const input = this.findInput ? this.findInput() : null;
        if (input && input.closest) {
          let box = input;
          let scope = null;
          for (let up = 0; up < 6 && box && box.parentElement; up++) {
            box = box.parentElement;
            if (this.__isTokFreeOverlay(box)) break;
            // 逐步向上取最外层的「含按钮的输入区容器」
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
          return false;
        } catch (_) { return false; }
      };
      const cands = root.querySelectorAll('button, [role="button"], span');
      let best = null;
      for (const el of cands) {
        if (this.__isTokFreeOverlay(el)) continue;
        if (!this.isElementVisible(el)) continue;
        const t = (el.textContent || '').trim();
        if (!t || t.length > 20) continue;
        if (!/深度思考|DeepThink|Deep\s?Think|R1/.test(t)) continue;
        // 取最内层（文案最短）的候选，再向上找最近的可点击祖先
        if (!best || t.length < (best.textContent || '').trim().length) best = el;
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

      // 策略2：aria-pressed / class 含 deep|think 的可点击元素（文案无法命中时的兜底）
      const attrSelectors = [
        '[aria-pressed][class*="deep"]',
        '[aria-pressed][class*="think"]',
        '[class*="deepThink"]',
        '[class*="deep-think"]',
        '[class*="deep"][role="button"]',
        '[class*="think"][role="button"]',
        '[data-testid*="deep"]',
        '[data-testid*="think"]',
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
      if (/active|selected|checked|enabled|is-on|ds-button--primary|filled/i.test(cls)) return true;
      try {
        const inner = btn.querySelector('[class*="active"], [class*="selected"], [class*="checked"]');
        if (inner) return true;
      } catch (_) {}
      return false;
    } catch (_) { return false; }
  },

  // 把深度思考切到目标状态（已是目标态则不动）
  // @returns {{ok:boolean, changed:boolean, available:boolean, error?:string}}
  setDeepThink(on) {
    try {
      const btn = this.getDeepThinkButton();
      if (!btn) return { ok: false, changed: false, available: false };
      const want = !!on;
      if (this.isDeepThinkOn() === want) return { ok: true, changed: false, available: true };
      // DeepSeek 等 React 站点必须用原生 el.click()，鼠标事件序列无效
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

  // 提取当前用户信息文本（脱敏手机号/微信昵称）
  extractUserInfo() {
    const el = document.querySelector('._9d8da05');
    return el ? el.textContent.trim() : '';
  },

  // 首页判断正则（用于覆盖层首页模式）
  homeUrlPattern: /^https:\/\/chat\.deepseek\.com\/?(\?.*)?$/,

  // 从 URL 提取会话 ID
  extractSessionId(url) {
    if (!url) return null;
    const match = url.match(/\/chat\/s\/([a-f0-9-]+)/i);
    if (match) return match[1];
    const altMatch = url.match(/\/s\/([a-f0-9-]+)/i);
    return altMatch ? altMatch[1] : null;
  },

  // 判断 URL 是否属于本平台
  matchesUrl(url) {
    // 兼容国内外节点：匹配 deepseek.com 任意子域（chat.deepseek.com 及海外可能的不同子域）。
    // 用 hostname 精确匹配，避免 'evil-deepseek.com' 之类误命中。
    try {
      const h = new URL(url).hostname.toLowerCase();
      return h === 'deepseek.com' || h.endsWith('.deepseek.com');
    } catch (_) {
      return String(url || '').includes('deepseek.com');
    }
  },

  // 判断元素是否可见（offsetWidth/offsetHeight > 0）
  isElementVisible(el) {
    if (!el) return false;
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  },

  // ========== 自动解析相关方法 ==========

  // 是否正在生成中（输入框右下角是「停止」按钮 → 运行中）
  // 只认真实「停止按钮」：AI 结束/中断 → 它消失 → false → 心跳停刷 → 看门狗催。
  // 会导致 isGenerating() 永远为真、心跳永不老化、看门狗永不催促。
  isGenerating() {
    // 多策略：语义属性(aria-label/title) 优先 → 宽 class 兜底，命中可见元素即视为生成中。
    // 站点改版时单一选择器会静默失效 → isGenerating 恒 false → 心跳不刷 → 看门狗误催。
    const selectors = [
      '[aria-label*="停止"]',
      '[title*="停止"]',
      '[aria-label*="Stop"]',
      '[aria-label*="stop"]',
      '[title*="Stop"]',
      '[class*="stop-button"]',
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

  // 判断 AI 是否已完成回复
  isResponseComplete() {
    try {
      let btnCount = 0;
      const messages = document.querySelectorAll('.ds-message');
      if (messages.length === 0) return false;
      const lastMessage = messages[messages.length - 1];
      const scope = lastMessage.parentElement || lastMessage;
      const actionButtons = scope.querySelectorAll(ACTION_BTN_SELECTOR);
      btnCount = actionButtons.length;
      const stopBtn = document.querySelector(STOP_BTN_SELECTOR);
      return btnCount >= 2 && !!stopBtn;
    } catch (err) {
      console.error('[TokFree] ❌ 检测 AI 完成状态出错:', err);
      return false;
    }
  },

  // 获取当前页面所有 AI 消息容器（排除用户消息）
  getMessageCandidates() {
    return Array.from(document.querySelectorAll('.ds-message')).filter(el => !this.isUserMessage(el));
  },

  // 从消息容器中取回复内容根节点
  getMessageMarkdown(messageEl) {
    return messageEl.querySelector(':scope > .ds-markdown');
  },

  // 判断节点是否位于用户消息区域内
  isUserMessage(node) {
    let current = node;
    while (current) {
      const role = current.getAttribute?.('data-role') || current.getAttribute?.('data-author') || '';
      if (role === 'user' || role === 'human') return true;
      const cls = current.className || '';
      if (typeof cls === 'string' && (cls.includes('user-message') || cls.includes('message-user') || cls.includes('human'))) {
        return true;
      }
      current = current.parentElement;
    }
    const text = (node.textContent || node.innerText || '').substring(0, 200);
    return text.includes('我已选择目录：') || text.includes('系统提示词：') || text.includes('工具使用规则：');
  },

  // 提取代码块的语言标记（小写）
  getCodeBlockLanguage(pre) {
    if (!pre) return '';
    let lang = pre.getAttribute('data-language') || '';
    if (!lang) {
      const parentDiv = pre.closest('div[data-language]');
      if (parentDiv) lang = parentDiv.getAttribute('data-language') || '';
    }
    if (!lang) {
      const codeEl = pre.querySelector('code');
      const els = [codeEl, pre].filter(Boolean);
      for (const el of els) {
        const cls = Array.from(el.classList).find((c) => c.startsWith('language-'));
        if (cls) { lang = cls.replace('language-', ''); break; }
      }
    }
    if (!lang) {
      const block = pre.closest('.md-code-block');
      if (block) {
        const banner = block.querySelector('.md-code-block-banner');
        if (banner) {
          const spans = banner.querySelectorAll('span');
          for (const span of spans) {
            if (span.closest('button')) continue;
            const t = (span.textContent || '').trim();
            if (/^[a-zA-Z0-9_+#.-]{1,20}$/.test(t)) {
              lang = t;
              break;
            }
          }
        }
      }
    }
    return (lang || '').toLowerCase();
  },
  // ========== 登录页检测与自动登录（供 login-manager 用）==========
  // 说明：这些方法会被序列化后在页面上下文执行，故不依赖 this。

  // 辅助：元素是否可见（登录页判定必须基于"可见元素"，否则主界面里隐藏的
  // password input / 侧边栏文字会导致误判）
  __ckVisible(el) {
    try {
      if (!el) return false;
      if (el.offsetWidth > 0 && el.offsetHeight > 0) return true;
      // 兜底：某些元素 offsetWidth 为 0 但 getClientRects 有值（如 inline）
      return !!(el.getClientRects && el.getClientRects().length);
    } catch (_) { return false; }
  },

  // 当前是否在登录页（未登录）
  // ⚠️ 关键：检查"可见的"实际表单元素，不只看 URL（页面加载中时 URL 已是 /sign_in 但表单未渲染）
  // ⚠️ 必须要求可见：主界面常存在隐藏的 input[type=password]（密码管理器兼容），
  //    若不判断可见性会把主界面误判为登录页。
  isLoginPage() {
    try {
      const visible = function (el) { try { if (!el) return false; if (el.offsetWidth > 0 && el.offsetHeight > 0) return true; return !!(el.getClientRects && el.getClientRects().length); } catch (_) { return false; } };
      // 可见的密码框 = 在登录表单
      const pwds = document.querySelectorAll('input[type=password]');
      for (let i = 0; i < pwds.length; i++) { if (visible(pwds[i])) return true; }
      // 可见的手机号框（国内版默认「手机验证码登录」表单）。
      // ⚠️ 原实现要求「手机框 + 发送验证码按钮」双条件，但 DeepSeek 验证码页按钮文案
      // 可能是「获取验证码」「重新发送」「发送验证码」等，且有倒计时禁用态（button 变 span）。
      // 放宽为：只要存在可见手机框 + 任一「验证码/登录」相关可见控件，即判定登录页。
      const tels = document.querySelectorAll('input[type=tel]');
      let visibleTel = null;
      for (let i = 0; i < tels.length; i++) { if (visible(tels[i])) { visibleTel = tels[i]; break; } }
      if (visibleTel) {
        const hasCodeCtl = Array.from(document.querySelectorAll('button, [role=button], div.ds-button, span, a'))
          .some(el => { const t = (el.textContent||'').trim(); return visible(el) && /发送验证码|获取验证码|验证码|重新发送|重新获取|登录/.test(t); });
        if (hasCodeCtl) return true;
        // 兜底：手机号框存在本身即强信号（登录页独有），避免按钮文案差异导致漏判
        return true;
      }
      // 海外版：登录页默认就是「邮箱+密码」表单（国内版默认手机验证码）。
      // 若存在可见的邮箱/账号输入框 + 可见的登录按钮，也判定为登录页，避免海外节点误判为非登录页。
      const emailInputs = document.querySelectorAll('input[type=email], input[type=text]');
      let visibleEmail = null;
      for (let i = 0; i < emailInputs.length; i++) {
        const el = emailInputs[i];
        if (!visible(el)) continue;
        const ph = (el.placeholder || '') + (el.getAttribute('name') || '') + (el.getAttribute('autocomplete') || '');
        if (/邮箱|账号|手机|email|account|phone|username/i.test(ph)) { visibleEmail = el; break; }
      }
      if (visibleEmail) {
        const hasLoginBtn = Array.from(document.querySelectorAll('button, [role=button], div.ds-button'))
          .some(b => { const t=(b.textContent||'').trim(); return visible(b) && !b.disabled && (t==='登录'||t==='登 录'||t==='Log in'||t==='Login'||t==='Sign in'); });
        if (hasLoginBtn) return true;
      }
      // 可见的「密码登录」入口（限定在表单类容器内，且要求可见）
      const entries = document.querySelectorAll('div.ds-button, button, [role=button]');
      for (let i = 0; i < entries.length; i++) {
        const el = entries[i];
        if (!visible(el)) continue;
        const t = (el.textContent||'').trim();
        if (t === '密码登录' || t === '账号密码登录' || t === '密码/账号登录') return true;
      }
      return false;
    } catch (_) { return false; }
  },

  // 是否已进入主界面（已登录）：有可见的聊天输入框即判定为主界面
  // ⚠️ 不再检查 password input（主界面可能有隐藏的 password 框，会误伤）
  isMainInterface() {
    try {
      const visible = function (el) { try { if (!el) return false; if (el.offsetWidth > 0 && el.offsetHeight > 0) return true; return !!(el.getClientRects && el.getClientRects().length); } catch (_) { return false; } };
      // 可见的聊天输入框 = 主界面（最强信号，优先判定）
      const tas = document.querySelectorAll('textarea');
      for (let i = 0; i < tas.length; i++) { if (visible(tas[i])) return true; }
      const ces = document.querySelectorAll('div[contenteditable="true"], [role="textbox"]');
      for (let i = 0; i < ces.length; i++) { if (visible(ces[i])) return true; }
      return false;
    } catch (_) { return false; }
  },

  // 账密登录入口（把默认的验证码登录切到密码登录）
  findPasswordLoginEntry() {
    const els = Array.from(document.querySelectorAll('button, [role=button], div.ds-button, span'));
    for (const el of els) {
      const t = (el.textContent || '').trim();
      if (t === '密码登录' || t === '账号密码登录' || t === '密码/账号登录') return el;
    }
    return null;
  },

  findUsernameInput() {
    const cands = Array.from(document.querySelectorAll('input'));
    return cands.find(el => {
      const t = el.type;
      const ph = (el.placeholder || '');
      return (t === 'text' || t === 'email' || t === 'tel') && (ph.indexOf('邮箱') !== -1 || ph.indexOf('手机') !== -1 || ph.indexOf('账号') !== -1 || ph.indexOf('Email') !== -1 || ph.indexOf('phone') !== -1);
    }) || cands.find(el => el.type === 'text' || el.type === 'email' || el.type === 'tel') || null;
  },

  findPasswordInput() {
    return document.querySelector('input[type=password]');
  },

  findLoginSubmit() {
    const btns = Array.from(document.querySelectorAll('button, [role=button], div.ds-button'));
    for (const b of btns) {
      const t = (b.textContent || '').trim();
      if ((t === '登录' || t === '登 录' || t === 'Log in' || t === 'Login') && !b.disabled) return b;
    }
    return null;
  },

  // 登录失败提示（如密码错误/账号不存在），无则 null
  detectLoginError() {
    const text = (document.body.innerText || '');
    const patterns = ['密码错误', '账号不存在', '账号或密码', '密码不正确', '登录失败', '验证码错误', '操作过于频繁', 'inorrect', 'Invalid', 'wrong password'];
    for (const p of patterns) { if (text.indexOf(p) !== -1) return p; }
    return null;
  },};
