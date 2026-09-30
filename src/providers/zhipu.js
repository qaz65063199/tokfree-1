/**
 * 智谱清言（chatglm.cn）Provider —— 网络拦截模式（2026-09-22 升级）
 *
 * 模式：useIntercept: true —— 走网络拦截（hook 覆盖 window.fetch/XHR，
 *   解析 chatglm.cn assistant/stream SSE 流），替代原 DOM 抓取。
 *   hook 源码位于 src/interceptor/zhipu-hook.js，由 preload/index.js 白名单注入，
 *   provider 本身不再自注入（原 getHookSource / 末尾 IIFE 已移除）。
 *
 * 真机实测 DOM 结论（Edge + DevTools，chatglm.cn/main/alltoolsdetail）：
 * - 输入框：textarea.scroll-display-none（无 placeholder，占位"和我聊聊天吧"为相邻装饰元素）
 * - 发送按钮：div.enter（非 button），内含 .enter-icon-container（无内容时含 empty class）
 * - 用户消息：.conversation.question（class 串 "conversation question pr flex..."，内含 .user-name）
 * - 会话 URL：/main/alltoolsdetail?lang=zh&cid=<sessionId>；首页：chatglm.cn 下无 cid 的 URL
 * - 反调试：DevTools 打开时匿名 debugger 死循环暂停（不影响 preload 注入链路）
 * - 发送：智谱只响应真实输入（isTrusted=true），合成 click/pointerdown/Enter 全部免疫；
 *   必须经主进程 webContents.sendInputEvent 注入原生 Enter（见 triggerSend）
 *
 * 说明：网络拦截模式不需要 DOM 回复解析方法（isGenerating / isResponseComplete /
 *   getMessageCandidates / getMessageMarkdown / isUserMessage / getCodeBlockLanguage 等），
 *   AI 回复由拦截器通过 onInterceptedResponse 事件提供。
 */
module.exports = {
  id: 'zhipu',
  name: '智谱清言',
  // 使用网络请求拦截方式获取 AI 回复（替代 DOM 抓取）
  useIntercept: true,
  homeUrl: 'https://chatglm.cn/',
  sessionUrlBase: 'https://chatglm.cn/main/alltoolsdetail?lang=zh&cid=',

  // 判断元素是否可见（offsetWidth/offsetHeight > 0）
  isElementVisible(el) {
    if (!el) return false;
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  },

  // 查找可见的聊天输入框（智谱 textarea 无 placeholder，直接按结构定位）
  // ⚠️ 排除 TokFree 覆盖层内的输入框（避免命中覆盖层"补充说明"框）
  findInput() {
    const list = document.querySelectorAll('textarea.scroll-display-none, textarea');
    for (const ta of list) {
      if (ta.closest && ta.closest('#tokfree-overlay, [id^="tokfree-"]')) continue;
      try {
        const style = window.getComputedStyle(ta);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      } catch (_) { /* 环境无 window 时信任存在性 */ }
      return ta;
    }
    return null;
  },

  // 查找发送按钮（div.enter，非 button）
  // 注：智谱免疫合成点击，该按钮仅作语义返回；实际发送走 triggerSend 原生 Enter
  findSendButton() {
    const enter = document.querySelector('.enter');
    if (!enter) return null;
    const icon = document.querySelector('.enter-icon-container');
    if (icon && /empty/.test(icon.className)) return null; // 空态不可发送
    return enter;
  },

  /**
   * 站点原生发送触发（智谱主路径）
   * 智谱只响应真实输入（isTrusted=true），合成事件全部免疫；
   * 经主进程 webContents.sendInputEvent 注入原生 Enter（焦点在输入框时等效真实按键）。
   * @param {Element} input 输入框元素
   * @returns {Promise<boolean>} 是否已处理（true 阻止通用发送逻辑继续）
   */
  async triggerSend(input) {
    if (input && window.electronAPI && typeof window.electronAPI.sendEnterToChat === 'function') {
      try {
        await window.electronAPI.sendEnterToChat();
      } catch (_) { /* IPC 失败时回退通用逻辑 */ }
      console.log('[TokFree] 智谱：已请求原生 Enter 发送（sendInputEvent）');
      return true;
    }
    return false;
  },

  // 提取当前用户信息文本（未登录显示"访客_xxx"）
  extractUserInfo() {
    const el = document.querySelector('.user-name');
    return el ? el.textContent.trim() : '';
  },

  // ========== 登录页检测（供 login-manager 用）==========
  // 智谱用「微信扫码 / 手机号验证码」登录，无传统账密表单，
  // 故只提供 isLoginPage / isMainInterface（账密类方法不适用，不实现）。
  // 判断依据：已登录有头像 / 用户名（非"访客"）/ "积分"区域；未登录有可见"登录"入口。

  // 是否为 TokFree 覆盖层内的元素（避免误命中覆盖层按钮）
  __isZhipuOverlay(el) {
    try {
      if (!el || typeof el.closest !== 'function') return false;
      return !!el.closest('#tokfree-overlay, #tokfree-window-manager, #tokfree-settings-drawer, [id^="tokfree-"]');
    } catch (_) { return false; }
  },

  // 是否存在「已登录」信号：头像 / 非访客用户名 / "积分"区域。
  __hasLoggedInSignal() {
    try {
      // 1) 头像：img[alt*="头像"] / class 含 avatar 的可见元素
      const avatarSels = [
        'img[alt*="头像"]',
        'img[alt*="avatar" i]',
        '[class*="avatar"] img',
        'img[class*="avatar"]',
        '[class*="user-avatar"]',
      ];
      for (const sel of avatarSels) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (this.__isZhipuOverlay(el)) continue;
            if (this.isElementVisible(el)) return true;
          }
        } catch (_) { /* 非法选择器跳过 */ }
      }
      // 2) 用户名：.user-name 文本非空且非"访客"（未登录时智谱显示"访客_xxx"）
      try {
        const nameEls = document.querySelectorAll('.user-name, [class*="user-name"]');
        for (const el of nameEls) {
          if (this.__isZhipuOverlay(el)) continue;
          const t = (el.textContent || '').trim();
          if (t && !/访客|guest|登录|注册/i.test(t)) return true;
        }
      } catch (_) {}
      // 3) "积分"区域（已登录才显示；限定在用户/积分相关容器内，避免全文扫描误判）
      try {
        const scopeSels = ['[class*="point"]', '[class*="integral"]', '[class*="credit"]', '[class*="user-info"]'];
        for (const sel of scopeSels) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (this.__isZhipuOverlay(el)) continue;
            const t = (el.textContent || '').trim();
            if (t && /积分/.test(t) && this.isElementVisible(el)) return true;
          }
        }
      } catch (_) {}
      return false;
    } catch (_) { return false; }
  },

  // 是否存在可见的「登录 / 注册」入口（未登录信号）。
  __hasVisibleSignIn() {
    try {
      const cands = document.querySelectorAll('button, a, [role="button"], span, div');
      for (const el of cands) {
        if (this.__isZhipuOverlay(el)) continue;
        const t = (el.textContent || '').trim();
        if (!t || t.length > 8) continue;
        if (t !== '登录' && t !== '注册' && t !== '登录注册' && t !== '立即登录' && t !== '登录或注册') continue;
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

  // 首页判断正则（chatglm.cn 下无 cid 参数；对话页带 cid=xxx）
  homeUrlPattern: /^https:\/\/chatglm\.cn\/?(#|\?lang=[^&]*)?$/i,

  // 从 URL 提取会话 ID（仅 chatglm.cn 的 cid 参数）
  extractSessionId(url) {
    if (!url) return null;
    const m = url.match(/[?&]cid=([a-f0-9-]+)/i);
    return m ? m[1] : null;
  },

  // 判断 URL 是否属于本平台
  matchesUrl(url) {
    if (!url) return false;
    try {
      const host = new URL(url).hostname;
      return /(^|\.)chatglm\.cn$/i.test(host);
    } catch (_) {
      return false;
    }
  },

  // ========== 深度思考开关：检测与切换（壳端深度思考开关在智谱窗口复用） ==========
  // 智谱 chatglm.cn 的深度思考按钮结构随版本变化，多策略容错：找不到一律返回 null / false / {ok:false}，绝不抛错。
  // 严格排除 TokFree 覆盖层元素（防误命中覆盖层按钮）。

  // 查找「深度思考」开关按钮元素；找不到返回 null
  getDeepThinkButton() {
    try {
      const isOverlay = (el) => {
        try {
          if (!el || typeof el.closest !== 'function') return false;
          return !!el.closest('#tokfree-overlay, #tokfree-window-manager, #tokfree-settings-drawer, [id^="tokfree-"]');
        } catch (_) { return false; }
      };
      // 策略0（真机确认，chatglm.cn 2026-09）：智谱深度思考入口真实 class 为 div.think-mode-trigger，
      //   内含 span.think-label + span.think-label-think（文案如"GLM-5.3极致"），
      //   点开后是「模型+思考强度」选择器（span.item-think / span.item-name-container / span.item-name）。
      //   该入口文案不含"深度思考"字样，文案匹配会漏，故必须作为首选选择器。
      try {
        const triggers = document.querySelectorAll('div.think-mode-trigger');
        for (const el of triggers) {
          if (isOverlay(el)) continue;
          if (!this.isElementVisible(el)) continue;
          return el;
        }
      } catch (_) { /* 忽略，继续文案兜底 */ }

      // 策略1：限定在「输入框附近的容器」内按文案查找（避免命中 AI 回复正文里的「深度思考」字样）
      let root = document;
      try {
        const input = this.findInput ? this.findInput() : null;
        if (input && input.closest) {
          let box = input;
          let scope = null;
          for (let up = 0; up < 6 && box && box.parentElement; up++) {
            box = box.parentElement;
            if (isOverlay(box)) break;
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
        if (isOverlay(el)) continue;
        if (!this.isElementVisible(el)) continue;
        const t = (el.textContent || '').trim();
        if (!t || t.length > 20) continue;
        if (!/深度思考|DeepThink|Deep\s?Think|深度思考模式/.test(t)) continue;
        if (!best || t.length < (best.textContent || '').trim().length) best = el;
      }
      if (best) {
        if (isClickable(best)) return best;
        let up = best;
        for (let i = 0; i < 3 && up && up.parentElement; i++) {
          const p = up.parentElement;
          if (isOverlay(p)) break;
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
            if (isOverlay(el)) continue;
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
      // 真机（chatglm.cn）：入口 div.think-mode-trigger 无 aria-pressed；
      //   读 span.think-label-think 文案（如"极致"）或已选中的 span.item-name 判断是否启用深度思考。
      try {
        const cls = (typeof btn.className === 'string' ? btn.className : '') || '';
        const isThinkTrigger = /think-mode-trigger/.test(cls) ||
          !!(btn.querySelector && btn.querySelector('.think-label-think'));
        if (isThinkTrigger) {
          const thinkLabel = btn.querySelector ? btn.querySelector('.think-label-think') : null;
          const txt = ((thinkLabel && thinkLabel.textContent) || '').trim();
          if (txt && /思考|极致|深度|think/i.test(txt)) return true;
          let selected = null;
          try {
            selected = document.querySelector(
              '.item-name-container .item-name.active, .item-name-container .item-name.selected, [class*="item-name"][class*="active"], [class*="item-name"][class*="selected"]'
            );
          } catch (_) {}
          if (selected && (selected.textContent || '').trim()) return true;
          return false;
        }
      } catch (_) {}
      const ap = btn.getAttribute && btn.getAttribute('aria-pressed');
      if (ap === 'true') return true;
      if (ap === 'false') return false;
      const ac = btn.getAttribute && btn.getAttribute('aria-checked');
      if (ac === 'true') return true;
      if (ac === 'false') return false;
      const cls = (typeof btn.className === 'string' ? btn.className : '') || '';
      if (/active|selected|checked|enabled|is-on|filled/i.test(cls)) return true;
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
      // React 站点必须用原生 el.click()，鼠标事件序列无效
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
