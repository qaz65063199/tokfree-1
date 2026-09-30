/**
 * 自定义平台 Provider 模板（新平台接入完整骨架）
 *
 * ========== 使用步骤 ==========
 *   1. 复制本文件，改名为你的平台 id（如 my-platform.js）
 *   2. 修改 id / name / homeUrl / sessionUrlBase / useIntercept 等基础字段
 *   3. 打开目标平台，用 DevTools 找到输入框、发送按钮、停止按钮、消息容器的选择器，
 *      填进下面带【TODO】注释的数组里（已给出常见兜底，多数平台改 1-2 条即可）
 *   4. 按平台实际 DOM 调整各方法；若平台走 SSE 拦截（useIntercept=true），
 *      可只填基础字段，DOM 相关方法保持默认实现即可
 *
 * ========== 重要提醒 ==========
 * - 所有选择器查找都要排除 TokFree 覆盖层元素（#tokfree-overlay / [id^="tokfree-"]），
 *   否则兜底选择器（如 'textarea'）会命中覆盖层的"补充说明"框，导致回执发错地方。
 * - 若希望支持「登录失效自动重登」，请实现 isLoginPage()；该方法会被序列化后在
 *   页面上下文执行，故内部不要依赖外部闭包变量（用 this 调用同对象的其它方法即可）。
 * - 若希望 AI 回复后自动抓取解析，必须实现 getMessageCandidates / getMessageMarkdown /
 *   isUserMessage / getCodeBlockLanguage。
 *
 * ========== 类型提示 ==========
 * 下方模块导出处已加 @type，IDE 会据此给出 provider.d.ts 的类型补全。
 */
/** @type {import('./custom/provider.d.ts').Provider} */
module.exports = {
  // ==================== 基础字段 ====================

  /** 【TODO】平台唯一标识（必填，小写短横线），如 'my-platform' */
  id: 'my-platform',
  /** 【TODO】显示名称（必填），出现在窗口标题/配置列表 */
  name: '我的平台',
  /** 【TODO】首页地址（必填），新建窗口时打开 */
  homeUrl: 'https://example.com/',
  /** 【TODO】会话 URL 前缀（必填），用于导航到指定会话 */
  sessionUrlBase: 'https://example.com/chat/',

  /**
   * 是否使用网络拦截（SSE）方式获取 AI 回复。
   * true  = 拦截站点流式响应（需该平台有对应 interceptor；无则退回 DOM 抓取）
   * false = 用 DOM 抓取方式解析回复（需实现下方消息解析方法）
   * 默认 false，若不确定先保持 false 并实现 DOM 解析。
   */
  useIntercept: false,

  /**
   * 输入框选择器（按优先级从上到下匹配）。
   * 【TODO】填平台实际输入框的选择器，已有常见兜底。
   */
  inputSelectors: [
    'textarea[placeholder*="输入"]',
    'textarea[placeholder*="message"]',
    'textarea[placeholder*="Message"]',
    'textarea[placeholder*="ask"]',
    'textarea',
    'div[contenteditable="true"]',
    '[role="textbox"]',
  ],

  /**
   * 发送按钮选择器（按优先级从上到下匹配）。
   * 【TODO】填平台实际发送按钮选择器。
   */
  sendButtonSelectors: [
    'button[type="submit"]',
    'button[aria-label*="send"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="发送"]',
    'button[title*="send"]',
    'button[title*="发送"]',
    '[data-testid="send-button"]',
  ],

  /**
   * 停止按钮选择器（用于检测"AI 正在生成"）。
   * 【TODO】很多平台生成中会把发送按钮替换为停止按钮，填该停止按钮选择器。
   * 若平台没有明显停止按钮，可留空数组，并改写 isGenerating() 用别的方式判断。
   */
  stopButtonSelectors: [
    'button[aria-label*="Stop"]',
    'button[aria-label*="停止"]',
    'button[title*="停止"]',
    'button.stop-button',
  ],

  /**
   * 消息容器选择器（AI 回复的每条消息外层容器）。
   * 【TODO】填平台实际消息容器选择器（用于 DOM 抓取解析）。
   */
  messageSelectors: [
    '[class*="message"]',
    '[data-testid*="message"]',
  ],

  /** 【TODO】用户信息元素选择器（用于窗口标题显示昵称/邮箱，可留空） */
  userInfoSelector: '[class*="user-name"], [class*="userName"], [class*="user-info"]',

  /** 【TODO】首页 URL 正则（判断当前是否在平台首页/新建会话页） */
  homeUrlPattern: /^https:\/\/example\.com\/?(\?.*)?$/,

  /** 输入框关键词兜底（找不到选择器时，用 placeholder/aria-label 文本匹配） */
  inputKeywords: ['输入', '消息', 'message', 'ask', '提问'],

  // ==================== 基础工具方法 ====================

  /**
   * 判断元素是否可见。
   * 默认：offsetWidth/offsetHeight > 0；对 inline 元素用 getClientRects 兜底。
   * 一般无需修改。
   */
  isElementVisible(el) {
    if (!el) return false;
    try {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) return true;
      return !!(el.getClientRects && el.getClientRects().length);
    } catch (_) { return false; }
  },

  /** 判断元素是否位于 TokFree 覆盖层内（内部辅助，避免命中覆盖层控件） */
  __inOverlay(el) {
    try {
      if (!el || typeof el.closest !== 'function') return false;
      return !!el.closest('#tokfree-overlay, [id^="tokfree-"]');
    } catch (_) { return false; }
  },

  // ==================== 输入框 / 发送按钮 ====================

  /**
   * 查找可见的聊天输入框。
   * 遍历 inputSelectors，排除覆盖层元素，返回第一个可见的。
   * 【TODO】多数平台改 inputSelectors 即可，此方法一般不用动。
   */
  findInput() {
    const selectors = this.inputSelectors || [];
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (this.__inOverlay(el)) continue;
          if (this.isElementVisible(el)) return el;
        }
      } catch (_) { /* 选择器不合法时跳过 */ }
    }
    return null;
  },

  /**
   * 查找可见且未禁用的发送按钮。
   * 遍历 sendButtonSelectors，排除覆盖层按钮。
   * 【TODO】多数平台改 sendButtonSelectors 即可。
   */
  findSendButton() {
    const selectors = this.sendButtonSelectors || [];
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const btn of els) {
          if (this.__inOverlay(btn)) continue;
          if (!this.isElementVisible(btn) || btn.disabled) continue;
          return btn;
        }
      } catch (_) { /* 选择器不合法时跳过 */ }
    }
    return null;
  },

  // ==================== 生成状态检测 ====================

  /**
   * 是否正在生成中。
   * 默认：stopButtonSelectors 中存在可见的停止按钮 → 生成中。
   * 【TODO】若平台无停止按钮，请改写本方法（如检测"发送按钮消失/输入框禁用"）。
   */
  isGenerating() {
    const selectors = this.stopButtonSelectors || [];
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (this.isElementVisible(el)) return true;
        }
      } catch (_) { /* 忽略 */ }
    }
    return false;
  },

  /**
   * 判断 AI 是否已完成回复。
   * 默认：停止按钮消失即视为完成（最简可用）。
   * ⚠️ 简单实现可能在"发送瞬间按钮抖动"时误判，生产环境建议参考内置 provider
   *    （如 qwen.js）做"停止按钮持续存在 > N ms 后消失"的边沿触发。
   * 【TODO】按平台实际完成信号调整。
   */
  isResponseComplete() {
    return !this.isGenerating();
  },

  // ==================== 登录状态检测 ====================

  /**
   * 是否在登录页（未登录）。
   * 默认：存在【可见】的密码框，或【可见】的账号框 + 登录按钮。
   * ⚠️ 必须基于"可见元素"判断：主界面常存在隐藏的 input[type=password]（密码管理器兼容），
   *    不看可见性会把已登录主界面误判为登录页。
   * 【TODO】按平台登录表单结构微调。
   */
  isLoginPage() {
    try {
      const visible = (el) => this.isElementVisible(el);

      // 1) 可见的密码框 → 在登录表单
      const pwds = document.querySelectorAll('input[type=password]');
      for (const p of pwds) { if (visible(p)) return true; }

      // 2) 可见的账号框（邮箱/手机/文本）+ 任一"登录/验证码"相关可见控件
      const accounts = document.querySelectorAll(
        'input[type=email], input[type=tel], input[name*="account"], input[name*="email"], input[name*="phone"]'
      );
      for (const acc of accounts) {
        if (!visible(acc)) continue;
        const hasLoginCtl = Array.from(
          document.querySelectorAll('button, [role=button], a, span')
        ).some((el) => {
          const t = (el.textContent || '').trim();
          return visible(el) && /登录|登陆|验证码|Sign in|Log in|Continue/.test(t);
        });
        if (hasLoginCtl) return true;
      }
      return false;
    } catch (_) { return false; }
  },

  /**
   * 是否在主界面（已登录、可正常对话）。
   * 默认：存在可见的聊天输入框即视为在主界面。
   * 【TODO】多数平台无需修改。
   */
  isMainInterface() {
    try {
      return !!this.findInput();
    } catch (_) { return false; }
  },

  /**
   * 检测登录时是否出现错误提示（如"账号或密码错误""环境异常"）。
   * 默认返回 null（表示未检测到错误，不干预自动登录）。
   * 【TODO】若平台有明确错误提示元素，返回该文本；否则保持 null 即可。
   * @returns {string|null} 错误文本；无错误返回 null
   */
  detectLoginError() {
    return null;
  },

  // ==================== URL 相关 ====================

  /**
   * 从 URL 提取会话 ID。
   * 【TODO】按平台会话路径改写正则。示例：/chat/{id} → 返回 {id}。
   * @returns {string|null}
   */
  extractSessionId(url) {
    if (!url) return null;
    const m = url.match(/\/chat\/([a-zA-Z0-9_-]+)/i);
    return m ? m[1] : null;
  },

  /**
   * 判断 URL 是否属于本平台。
   * ⚠️ 建议用 hostname 精确匹配（避免 'evil-example.com' 误命中）。
   * 【TODO】改成你的平台域名。
   */
  matchesUrl(url) {
    if (!url) return false;
    try {
      const h = new URL(url).hostname.toLowerCase();
      return h === 'example.com' || h.endsWith('.example.com');
    } catch (_) {
      return String(url).includes('example.com');
    }
  },

  // ==================== 用户信息 ====================

  /**
   * 提取用户信息文本（昵称/邮箱），用于窗口标题。
   * 默认：读 userInfoSelector 的 textContent（≤60 字符有效）。
   * 【TODO】可选实现：也可从 localStorage/接口获取（参考 qwen.js 的多级兜底）。
   * @returns {string}
   */
  extractUserInfo() {
    try {
      const el = document.querySelector(this.userInfoSelector);
      if (!el) return '';
      const text = (el.textContent || '').trim();
      return text.length <= 60 ? text : '';
    } catch (_) { return ''; }
  },

  // ==================== 消息解析（DOM 抓取用） ====================

  /**
   * 获取当前页面所有 AI 消息容器（排除用户消息）。
   * 【TODO】按平台消息容器选择器调整。
   * @returns {Element[]}
   */
  getMessageCandidates() {
    const selectors = this.messageSelectors || [];
    for (const sel of selectors) {
      try {
        const list = Array.from(document.querySelectorAll(sel));
        if (list.length > 0) {
          return list.filter((el) => !this.isUserMessage(el));
        }
      } catch (_) { /* 忽略 */ }
    }
    return [];
  },

  /**
   * 从消息容器中取回复内容根节点（Markdown 容器）。
   * 默认：容器内 [class*="markdown"]，找不到则返回容器本身。
   * 【TODO】按平台正文容器 class 调整。
   * @returns {Element|null}
   */
  getMessageMarkdown(messageEl) {
    if (!messageEl) return null;
    return messageEl.querySelector('[class*="markdown"]') || messageEl;
  },

  /**
   * 判断节点是否位于用户消息区域内。
   * 默认：向上爬父链，看 class 含 user-message/message-user/human，
   *       或 data-role/data-author 为 user/human。
   * 【TODO】按平台用户消息标识调整；末尾的 TokFree 回执文案兜底一般保留。
   * @returns {boolean}
   */
  isUserMessage(node) {
    let current = node;
    while (current) {
      const role = current.getAttribute?.('data-role') || current.getAttribute?.('data-author') || '';
      if (role === 'user' || role === 'human') return true;
      const cls = current.className || '';
      if (typeof cls === 'string' &&
          (cls.includes('user-message') || cls.includes('message-user') || cls.includes('human'))) {
        return true;
      }
      current = current.parentElement;
    }
    // 兜底：TokFree 发出的回执/提示文案属于"用户侧"，避免被当成 AI 回复解析
    const text = (node.textContent || node.innerText || '').substring(0, 200);
    return text.includes('我已选择目录：') || text.includes('系统提示词：') || text.includes('工具使用规则：');
  },

  /**
   * 提取代码块的语言标记（小写）。
   * 默认：code/pre 的 class 里 language-xxx。
   * 【TODO】部分平台语言标签在专门的 header 元素里（参考 qwen.js/deepseek.js）。
   * @returns {string}
   */
  getCodeBlockLanguage(pre) {
    if (!pre) return '';
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
    return '';
  },

  // ==================== 提示词模板 ====================

  /**
   * 返回平台自定义系统提示词模板（优先级最高）。
   * 返回非空字符串则直接使用；返回空字符串则回退到 src/prompt/{id}.md 文件模板。
   * 默认返回空字符串（用文件模板）。
   * 【TODO】如需在 JS 里内联提示词，返回完整模板字符串即可。
   * @returns {string}
   */
  getPromptTemplate() {
    return '';
  },
};
