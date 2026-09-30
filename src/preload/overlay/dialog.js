/**
 * 统一对话框模块（confirm / alert / prompt）
 *
 * 设计：完全自包含 —— 自行注入 CSS（#tokfree-dialog-style）与 DOM，
 * 不依赖覆盖层模板（template.js）或 ui.js 里的旧实现。
 * 视觉与 onboarding.js 保持一致：品牌紫罗兰 + 居中卡片 + 淡入动画。
 *
 * 全部 API 均返回 Promise：
 *   - confirm(message, {title, okText, cancelText}) -> Promise<boolean>
 *   - alert(message, {title, okText})               -> Promise<void>
 *   - prompt(message, {title, defaultValue, placeholder}) -> Promise<string|null>
 *
 * 交互：Esc 取消、Enter 确认、点击遮罩取消。
 * 同一时刻只保留一个对话框（新对话框会先取消旧的）。
 */
'use strict';

const STYLE_ID = 'tokfree-dialog-style';
const MASK_ID = 'tokfree-dlg-mask';
const BOX_ID = 'tokfree-dlg-box';
const TITLE_ID = 'tokfree-dlg-title';
const MSG_ID = 'tokfree-dlg-msg';
const INPUT_ID = 'tokfree-dlg-input';
const OK_ID = 'tokfree-dlg-ok';
const CANCEL_ID = 'tokfree-dlg-cancel';
const NL = String.fromCharCode(10);

/** 当前活跃的对话框句柄（保证互斥） */
let activeDialog = null;

/** 判断当前环境是否可操作 DOM（浏览器/渲染进程为 true；无 DOM 的测试环境为 false） */
function domAvailable() {
  return typeof document !== 'undefined' && !!document &&
    typeof document.createElement === 'function' &&
    !!document.head && typeof document.head.appendChild === 'function' &&
    !!document.body && typeof document.body.appendChild === 'function';
}

/** 注入对话框样式（幂等，只注入一次） */
function ensureStyle() {
  if (!domAvailable()) return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    // 遮罩层：全屏居中 + 淡入
    '#' + MASK_ID + ' { position: fixed; inset: 0; z-index: 2147483647; background: rgba(6,7,15,0.72); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; animation: tokfree-dlg-fade 0.18s ease-out; }',
    '@keyframes tokfree-dlg-fade { from { opacity: 0; } to { opacity: 1; } }',
    '@keyframes tokfree-dlg-pop { from { opacity: 0; transform: translateY(10px) scale(0.97); } to { opacity: 1; transform: none; } }',
    // 卡片：品牌紫罗兰描边 + 弹出动画
    '#' + BOX_ID + ' { width: 420px; max-width: 92vw; box-sizing: border-box; background: #161827; border: 1px solid rgba(124,108,255,0.28); border-radius: 18px; padding: 24px 24px 18px; box-shadow: 0 32px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(124,108,255,0.08); color: #e6e8f5; animation: tokfree-dlg-pop 0.2s cubic-bezier(0.22, 1, 0.36, 1); }',
    '#' + TITLE_ID + ' { font-size: 16px; font-weight: 800; letter-spacing: -0.2px; margin-bottom: 10px; }',
    '#' + MSG_ID + ' { font-size: 14px; color: #9298b8; line-height: 1.7; word-break: break-word; white-space: pre-wrap; }',
    // 输入框（prompt 专用）
    '#' + INPUT_ID + ' { width: 100%; box-sizing: border-box; margin-top: 16px; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(124,108,255,0.28); background: rgba(255,255,255,0.04); color: #e6e8f5; font-size: 14px; font-family: inherit; outline: none; transition: border-color 0.2s, box-shadow 0.2s; }',
    '#' + INPUT_ID + ':focus { border-color: #7c6cff; box-shadow: 0 0 0 3px rgba(124,108,255,0.18); }',
    '#' + INPUT_ID + '::placeholder { color: #5d6280; }',
    // 按钮区
    '#tokfree-dlg-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 22px; }',
    '#tokfree-dlg-actions button { padding: 9px 20px; border-radius: 10px; font-size: 13px; font-weight: 600; font-family: inherit; cursor: pointer; border: 1px solid transparent; transition: all 0.2s; }',
    '#' + OK_ID + ' { background: linear-gradient(135deg, #7c6cff, #6a58ff); color: #fff; box-shadow: 0 6px 18px rgba(124,108,255,0.3); }',
    '#' + OK_ID + ':hover { transform: translateY(-1px); box-shadow: 0 10px 26px rgba(124,108,255,0.45); }',
    '#' + CANCEL_ID + ' { background: transparent; color: #9298b8; border-color: rgba(255,255,255,0.1); }',
    '#' + CANCEL_ID + ':hover { color: #e6e8f5; background: rgba(255,255,255,0.05); }',
    // 浅色主题适配（应用通过 <html data-theme="light"> 切换）
    'html[data-theme="light"] #' + BOX_ID + ' { background: #ffffff; border-color: rgba(124,108,255,0.3); color: #1a1c2e; box-shadow: 0 32px 80px rgba(20,20,50,0.22); }',
    'html[data-theme="light"] #' + MSG_ID + ' { color: #5d6280; }',
    'html[data-theme="light"] #' + INPUT_ID + ' { background: rgba(0,0,0,0.03); color: #1a1c2e; }',
    'html[data-theme="light"] #' + CANCEL_ID + ' { color: #5d6280; border-color: rgba(0,0,0,0.12); }',
  ].join(NL);
  document.head.appendChild(style);
}

/** 安全字符串化：null/undefined -> ''，其余 -> String(v) */
function toText(v) {
  if (v === null || v === undefined) return '';
  try { return String(v); } catch (_) { return ''; }
}

/** HTML 转义（用于把用户文案安全拼进 innerHTML） */
function escapeHtml(str) {
  return toText(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 规范化选项：非法入参一律降级为默认值（容错） */
function normalizeOptions(options) {
  const o = (options && typeof options === 'object') ? options : {};
  return {
    title: toText(o.title),
    okText: toText(o.okText) || '确定',
    cancelText: toText(o.cancelText) || '取消',
    defaultValue: toText(o.defaultValue),
    placeholder: toText(o.placeholder),
  };
}

/** 拼装对话框内部 HTML */
function buildHtml(cfg) {
  return '<div id="' + BOX_ID + '">' +
    (cfg.title ? '<div id="' + TITLE_ID + '">' + escapeHtml(cfg.title) + '</div>' : '') +
    (cfg.message ? '<div id="' + MSG_ID + '">' + escapeHtml(cfg.message) + '</div>' : '') +
    (cfg.showInput ? '<input id="' + INPUT_ID + '" type="text" />' : '') +
    '<div id="tokfree-dlg-actions">' +
      (cfg.showCancel ? '<button id="' + CANCEL_ID + '" type="button">' + escapeHtml(cfg.cancelText) + '</button>' : '') +
      '<button id="' + OK_ID + '" type="button">' + escapeHtml(cfg.okText) + '</button>' +
    '</div>' +
  '</div>';
}

/**
 * 打开一个对话框（内部通用实现）
 * @param {object} config
 * @param {string} [config.title]       标题（空则不显示）
 * @param {string} [config.message]     正文（空则不显示）
 * @param {string} [config.okText]      确认按钮文案
 * @param {string} [config.cancelText]  取消按钮文案
 * @param {boolean} [config.showCancel] 是否显示取消按钮
 * @param {boolean} [config.showInput]  是否显示输入框
 * @param {string} [config.defaultValue] 输入框默认值
 * @param {string} [config.placeholder]  输入框占位符
 * @returns {Promise<{ok: boolean, value: string|null}>}
 */
function openDialog(config) {
  return new Promise(function (resolve) {
    const fallback = { ok: false, value: null };
    // 无 DOM 环境（如单元测试）直接降级，绝不抛错
    if (!domAvailable()) { resolve(fallback); return; }

    // 互斥：先取消尚未关闭的旧对话框
    if (activeDialog) { try { activeDialog.close(false); } catch (_) {} }

    const cfg = config || {};
    let settled = false;
    let mask = null;
    let input = null;
    let okBtn = null;

    /** 清理 DOM 与全局监听（全程容错，任何一步失败都不影响 promise 落地） */
    function cleanup() {
      if (activeDialog && activeDialog.mask === mask) activeDialog = null;
      try { document.removeEventListener('keydown', onKey, true); } catch (_) {}
      try {
        if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
        else if (mask && typeof mask.remove === 'function') mask.remove();
      } catch (_) {}
    }

    /** 关闭对话框并兑现 Promise（幂等） */
    function close(ok) {
      if (settled) return;
      settled = true;
      let value = null;
      if (ok && cfg.showInput && input) value = toText(input.value);
      cleanup();
      resolve({ ok: !!ok, value: value });
    }

    /** 键盘：Esc 取消、Enter 确认 */
    function onKey(e) {
      if (!e) return;
      if (e.key === 'Escape') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        close(false);
      } else if (e.key === 'Enter') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        close(true);
      }
    }

    try {
      ensureStyle();
      mask = document.createElement('div');
      mask.id = MASK_ID;
      mask.innerHTML = buildHtml(cfg);
      document.body.appendChild(mask);

      input = cfg.showInput ? mask.querySelector('#' + INPUT_ID) : null;
      if (input) {
        input.value = cfg.defaultValue || '';
        if (cfg.placeholder && typeof input.setAttribute === 'function') {
          input.setAttribute('placeholder', cfg.placeholder);
        }
      }
      okBtn = mask.querySelector('#' + OK_ID);
      const cancelBtn = mask.querySelector('#' + CANCEL_ID);

      if (okBtn) okBtn.addEventListener('click', function () { close(true); });
      if (cancelBtn) cancelBtn.addEventListener('click', function () { close(false); });
      // 点击遮罩（仅遮罩本身，不含卡片内）取消
      mask.addEventListener('click', function (e) { if (e.target === mask) close(false); });
      document.addEventListener('keydown', onKey, true);

      activeDialog = { mask: mask, close: close };

      // 焦点：优先输入框，其次确认按钮
      if (input && typeof input.focus === 'function') {
        input.focus();
        if (typeof input.select === 'function') input.select();
      } else if (okBtn && typeof okBtn.focus === 'function') {
        okBtn.focus();
      }
    } catch (_) {
      // DOM 构建失败（如环境 stub 不完整）也要优雅降级
      settled = true;
      cleanup();
      resolve(fallback);
    }
  });
}

/**
 * 确认对话框
 * @param {*} message 正文（非字符串会被安全转换）
 * @param {{title?: string, okText?: string, cancelText?: string}} [options]
 * @returns {Promise<boolean>} 点确认为 true，其余（取消/Esc/遮罩）为 false
 */
function confirm(message, options) {
  const o = normalizeOptions(options);
  return openDialog({
    title: o.title,
    message: toText(message),
    okText: o.okText,
    cancelText: o.cancelText,
    showCancel: true,
    showInput: false,
  }).then(function (r) { return !!r.ok; });
}

/**
 * 提示对话框（只有一个确认按钮）
 * @param {*} message 正文
 * @param {{title?: string, okText?: string}} [options]
 * @returns {Promise<void>}
 */
function alert(message, options) {
  const o = normalizeOptions(options);
  return openDialog({
    title: o.title,
    message: toText(message),
    okText: o.okText,
    showCancel: false,
    showInput: false,
  }).then(function () { return undefined; });
}

/**
 * 输入对话框
 * @param {*} message 正文
 * @param {{title?: string, defaultValue?: string, placeholder?: string, okText?: string, cancelText?: string}} [options]
 * @returns {Promise<string|null>} 确认返回输入内容（可为空串），取消返回 null
 */
function prompt(message, options) {
  const o = normalizeOptions(options);
  return openDialog({
    title: o.title,
    message: toText(message),
    okText: o.okText,
    cancelText: o.cancelText,
    defaultValue: o.defaultValue,
    placeholder: o.placeholder,
    showCancel: true,
    showInput: true,
  }).then(function (r) {
    if (!r.ok) return null;
    return r.value === null ? '' : r.value;
  });
}

module.exports = { confirm, alert, prompt };
