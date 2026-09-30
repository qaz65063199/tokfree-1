/**
 * 覆盖层 UI 基础能力：注入、提示、历史记录、徽章、面板显隐与巡检
 * 由原 preload.js 拆分而来，逻辑保持不变。
 */
const { OVERLAY_HTML, OVERLAY_CSS } = require('./template');
// onboarding 已移除：新手引导（三步欢迎引导）不再弹出
const themeManager = require('./theme-manager');
const { getProviderByUrl } = require('../../../src/providers');
const state = require('../dom/state');

// ========== 注入样式 ==========
/**
 * 注入覆盖层 CSS 样式到页面头部
 */
function injectCSS() {
  const style = document.createElement('style');
  style.textContent = OVERLAY_CSS;
  document.head.appendChild(style);
  // 先应用默认主题，再从主进程（唯一真源）异步同步并订阅变更
  applyTheme('light');
  syncThemeFromMain();
  try { themeManager.setTheme(themeManager.getTheme()); } catch (_) {}
}

/**
 * 当前主题缓存（唯一真源 = 主进程 settings.theme，经 electronAPI.getTheme /
 * onThemeChanged 同步到这里；不再依赖 process.argv 或 localStorage）。
 */
let currentTheme = 'light';

/**
 * 读取当前主题（同步缓存值）。
 * 数据来源为主进程 electronAPI.getTheme() 与 onThemeChanged 广播。
 * @returns {'dark'|'light'}
 */
function getSavedTheme() {
  return currentTheme;
}

/**
 * 从主进程同步主题：拉取当前值（异步）并订阅后续变更广播。
 * 无 electronAPI 时安全跳过。
 */
function syncThemeFromMain() {
  try {
    const api = window.electronAPI;
    if (!api) return;
    if (typeof api.getTheme === 'function') {
      Promise.resolve(api.getTheme()).then(function (r) {
        const t = r && r.theme;
        if (t === 'dark' || t === 'light') applyTheme(t);
      }).catch(function () {});
    }
    if (typeof api.onThemeChanged === 'function') {
      api.onThemeChanged(function (t) { applyTheme(t); });
    }
  } catch (_) {}
}

/**
 * 应用主题：显式二态 —— light/dark 都写入 <html data-theme>，
 * 不再「移除属性 = 默认暗色」，保证浅/深两态样式都正确。
 * @param {'dark'|'light'} theme
 * @returns {'dark'|'light'} 实际应用的主题
 */
function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  currentTheme = t;
  try { document.documentElement.setAttribute('data-theme', t); } catch (_) {}
  return t;
}

/**
 * 切换主题：调主进程 electronAPI.setTheme（取反），由 theme-changed 广播回来统一应用。
 * 无 electronAPI 时本地乐观切换（保证 UI 仍可响应）。
 * @returns {'dark'|'light'} 新主题
 */
function toggleTheme() {
  const next = currentTheme === 'light' ? 'dark' : 'light';
  try {
    if (window.electronAPI && typeof window.electronAPI.setTheme === 'function') {
      applyTheme(next); // 乐观应用，广播回来再应用一次（幂等）
      window.electronAPI.setTheme(next);
    } else {
      applyTheme(next);
    }
  } catch (_) { applyTheme(next); }
  return next;
}

// ========== 注入覆盖层 HTML ==========
/**
 * 注入覆盖层 HTML 到页面 body
 * 创建 tokfree-root 容器并填充 OVERLAY_HTML 内容
 */
/** 渐进披露已移除：保留空函数以兼容旧调用 */
function initProgressiveDisclosure() { /* no-op */ }

function injectOverlay() {
  const container = document.createElement('div');
  container.id = 'tokfree-root';
  container.innerHTML = OVERLAY_HTML;
  document.body.appendChild(container);
}

// ========== 覆盖层逻辑 ==========

let currentCommand = null;
let isExecuting = false;
let commandIdCounter = 0;
const commandHistory = [];

/**
 * 生成唯一命令 ID
 * @returns {string} 格式为 cmd_时间戳_序号 的唯一标识
 */
function generateId() {
  return `cmd_${Date.now()}_${++commandIdCounter}`;
}

/**
 * 格式化时间戳为 HH:mm:ss 格式
 * @param {number} ts - 时间戳（毫秒）
 * @returns {string} 格式化后的时间字符串
 */
function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 截断文本到指定长度，超出部分以 ... 结尾
 * @param {string} text - 要截断的文本
 * @param {number} maxLen - 最大长度，默认 50
 * @returns {string} 截断后的文本
 */
function truncate(text, maxLen = 50) {
  if (!text || text.length <= maxLen) return text || '';
  return text.substring(0, maxLen) + '...';
}

/**
 * HTML 转义，防止 XSS 攻击
 * @param {string} text - 要转义的文本
 * @returns {string} 转义后的 HTML 字符串
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * 显示浮动提示弹窗
 * @param {string} text - 提示文本
 * @param {number} duration - 显示时长（毫秒），默认 2200
 */
function showToast(text, duration = 2200) {
  let toast = document.getElementById('tokfree-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'tokfree-toast';
    toast.className = 'tokfree-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

/**
 * 显示带确认/取消按钮的持久提示框（不点击就一直存在）
 * @param {string} text - 提示文本
 * @param {object} [options] - 可选配置
 * @param {string} [options.okText] - 确定按钮文字，默认「确定」
 * @param {boolean} [options.showCancel] - 是否显示取消按钮，默认 false
 * @param {string} [options.cancelText] - 取消按钮文字，默认「取消」
 * @returns {Promise<boolean>} 用户点确定 resolve(true)，点取消 resolve(false)
 */
function showConfirmDialog(text, options) {
  // 兼容转发：内部升级到 dialog.js（精致对话框），4 处调用方签名不变。
  const opts = options || {};
  const dialogMod = require('./dialog');
  const dlgOpts = { okText: opts.okText, cancelText: opts.cancelText };
  if (opts.showCancel) {
    return dialogMod.confirm(text, dlgOpts);   // Promise<boolean>
  }
  return dialogMod.alert(text, dlgOpts).then(function () { return true; });  // Promise<boolean>
}

/** 兼容标记：内部已转发至 dialog.js */
const dialogCompat = true;
/**
 * 账号选择弹窗（真正的列表选择，替代 showConfirmDialog 的"默认选第一个"）
 * @param {Object} opts
 * @param {string} opts.reason - 提示原因
 * @param {Array} opts.accounts - 账号列表（含 hasPassword）
 * @returns {Promise<string|null>} 选中的 accountId，取消返回 null
 */
function showAccountSelectDialog(opts) {
  const o = opts || {};
  const accounts = o.accounts || [];
  const usage = o.usage || {};
  const curProfile = o.currentProfileId || '';

  const old = document.getElementById('tokfree-acct-select-dialog');
  if (old) old.remove();

  return new Promise((resolve) => {
    const dialog = document.createElement('div');
    dialog.id = 'tokfree-acct-select-dialog';
    dialog.style.cssText = [
      'position: fixed; top: 50%; left: 50%;',
      'transform: translate(-50%, -50%);',
      'z-index: 2147483648;',
      'width: 420px; max-width: 92vw; max-height: 80vh;',
      'background: var(--ck-bg-elevated, rgba(22, 24, 44, 0.98));',
      'backdrop-filter: blur(18px);',
      'border: 1px solid var(--ck-border, rgba(139, 147, 255, 0.35));',
      'border-radius: 14px;',
      'padding: 18px;',
      "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;",
      'color: var(--ck-text, #dde1ff); font-size: 13px;',
      'box-shadow: 0 16px 50px rgba(0, 0, 0, 0.55);',
      'display: flex; flex-direction: column;'
    ].join('');

    const items = accounts.map(a => {
      const usedBy = (usage[a.id] || []).filter(u => u.profileId !== curProfile);
      const isUsed = usedBy.length > 0;
      const noPwd = !a.hasPassword;
      const disabled = isUsed || noPwd;
      const tag = isUsed
        ? '<span style="color:var(--ck-yellow,#ff9a6b);font-size:11px;"> · 已被 ' + usedBy.map(u => u.profileName || u.profileId).join(', ') + ' 使用</span>'
        : (noPwd ? '<span style="color:var(--ck-yellow,#ff9a6b);font-size:11px;"> · 无密码</span>' : '');
      const name = a.label || a.username || a.id;
      const sub = (a.username || '') + (a.providerId ? ' · ' + a.providerId : '');
      return '<div class="tokfree-acct-pick-item" data-acct-id="' + a.id + '" ' + (disabled ? 'data-disabled="1"' : '') + ' style="' +
        'padding:10px 12px;margin-bottom:8px;border-radius:10px;cursor:' + (disabled ? 'not-allowed' : 'pointer') + ';' +
        'border:1px solid rgba(var(--ck-primary-rgb,139,147,255),' + (disabled ? '0.12' : '0.3') + ');' +
        'background:rgba(var(--ck-primary-rgb,139,147,255),' + (disabled ? '0.03' : '0.08') + ');' +
        'opacity:' + (disabled ? '0.5' : '1') + ';transition:all 0.2s;">' +
        '<div style="font-weight:600;color:var(--ck-text-strong,#c8ccff);">' + name + tag + '</div>' +
        '<div style="font-size:11px;color:var(--ck-text-dim,#8a90b8);margin-top:2px;">' + sub + '</div>' +
        '</div>';
    }).join('');

    dialog.innerHTML = [
      '<div style="font-size:14px;font-weight:700;margin-bottom:4px;">选择账号登录</div>',
      '<div style="font-size:12px;color:var(--ck-text-dim,#8a90b8);margin-bottom:12px;">' + (o.reason || '请选择一个账号') + '</div>',
      '<div style="overflow-y:auto;flex:1;min-height:40px;max-height:50vh;">' + (items || '<div style="color:var(--ck-text-dim,#8a90b8);padding:16px 0;">账号池为空，请先在「账号池」面板添加账号</div>') + '</div>',
      '<div style="text-align:right;margin-top:14px;">',
      '  <button id="tokfree-acct-pick-cancel" style="padding:9px 22px;border:1px solid rgba(139,147,255,0.4);border-radius:10px;background:transparent;color:#aab0ff;font-size:13px;font-weight:600;cursor:pointer;">取消</button>',
      '</div>'
    ].join('');
    document.body.appendChild(dialog);

    const cleanup = () => dialog.remove();

    dialog.querySelectorAll('.tokfree-acct-pick-item').forEach(el => {
      el.addEventListener('click', () => {
        if (el.dataset.disabled === '1') return;
        const id = el.dataset.acctId;
        cleanup();
        resolve(id);
      });
      el.addEventListener('mouseenter', () => {
        if (el.dataset.disabled !== '1') el.style.background = 'rgba(139,147,255,0.18)';
      });
      el.addEventListener('mouseleave', () => {
        if (el.dataset.disabled !== '1') el.style.background = 'rgba(139,147,255,0.08)';
      });
    });
    dialog.querySelector('#tokfree-acct-pick-cancel').addEventListener('click', () => {
      cleanup();
      resolve(null);
    });
  });
}

/**
 * 设置任务状态（检测到任务：后面的执行中提示）
 * @param {boolean} running - 是否执行中
 */
function setTaskStatus(running) {
  const status = document.getElementById('tokfree-task-status');
  if (status) {
    status.classList.toggle('tokfree-hidden', !running);
  }
}

/**
 * 显示覆盖层（移除 hidden 类）
 */
function showOverlay() {
  // 悬浮窗已彻底禁用：任何调用都不得让 #tokfree-overlay 显示
  hideOverlay();
}

/**
 * 隐藏覆盖层（添加 hidden 类）
 */
function hideOverlay() {
  const el = document.getElementById('tokfree-overlay');
  if (el) el.classList.add('tokfree-hidden');
}

/**
 * 显示命令预览并展开覆盖层
 * @param {Object} cmdData - 命令数据对象，包含 command、timestamp、id 等字段
 */
function displayCommand(cmdData) {
  currentCommand = cmdData;
  const preview = document.getElementById('tokfree-cmd-preview');
  const resultSection = document.getElementById('tokfree-result-section');
  if (preview) preview.textContent = cmdData.command;
  if (resultSection) resultSection.classList.add('tokfree-hidden');
  showToast('发现可执行的命令');
}

/**
 * 确认执行当前显示的命令
 * 已移除：确认执行按钮及相关交互。保留空函数以防其他引用。
 */
async function handleExecute() {
}

/**
 * 忽略当前命令
 * 已移除：忽略按钮及相关交互。保留空函数以防其他引用。
 */
function handleIgnore() {
}

/**
 * 添加一条历史记录
 * @param {Object} entry - 历史记录对象，包含 id、command、success、canceled、output、timestamp 等字段
 */
function addHistory(entry) {
  commandHistory.unshift(entry);
  if (commandHistory.length > 50) commandHistory.pop();
  renderHistory();
}

/**
 * 渲染历史记录列表
 * 将 commandHistory 中的记录渲染到界面，并为每条记录绑定点击事件以查看详情
 */
function renderHistory() {
  const list = document.getElementById('tokfree-history-list');
  if (!list) return;

  if (commandHistory.length === 0) {
    list.innerHTML = '<div style="color:#666;font-size:12px;font-style:italic;padding:8px 0;">暂无记录</div>';
    return;
  }

  const items = commandHistory.slice(0, 20);
  list.innerHTML = items.map((item) => `
    <div class="tokfree-history-item" data-id="${escapeHtml(item.id)}">
      <span class="tokfree-cmd-text">${escapeHtml(truncate(item.command, 60))}</span>
      <span class="tokfree-cmd-status ${item.canceled ? '' : item.success ? 'success' : 'error'}">
        ${item.canceled ? '⏹ 已忽略' : item.success ? '✅ 成功' : '❌ 失败'}
      </span>
      <span class="tokfree-cmd-time">${formatTime(item.timestamp)}</span>
    </div>
  `).join('');

  list.querySelectorAll('.tokfree-history-item').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const entry = commandHistory.find((h) => h.id === id);
      if (entry) {
        const preview = document.getElementById('tokfree-cmd-preview');
        const resultSection = document.getElementById('tokfree-result-section');
        const resultStatus = document.getElementById('tokfree-result-status');
        const resultOutput = document.getElementById('tokfree-result-output');
        if (preview) preview.textContent = entry.command;
        if (entry.output && resultSection) {
          resultSection.classList.remove('tokfree-hidden');
          if (resultStatus) {
            resultStatus.textContent = entry.canceled ? '⏹ 已忽略' : entry.success ? '✅ 执行成功' : '❌ 执行失败';
            resultStatus.className = `tokfree-result-status ${entry.success ? 'success' : 'error'}`;
          }
          if (resultOutput) resultOutput.textContent = entry.output || '(无输出)';
        }
        showOverlay();
      }
    });
  });
}

/**
 * 闪烁状态徽章提示
 */
function flashBadge() {
  const badge = document.getElementById('tokfree-status-badge');
  const dot = document.getElementById('tokfree-status-dot');
  if (badge) {
    badge.style.background = 'rgba(16,185,129,0.25)';
    badge.style.borderColor = 'rgba(16,185,129,0.6)';
    setTimeout(() => {
      badge.style.background = 'rgba(var(--ck-primary-rgb, 139, 147, 255), 0.22)';
      badge.style.borderColor = 'rgba(var(--ck-primary-rgb, 139, 147, 255), 0.4)';
    }, 3000);
  }
  if (dot) {
    dot.style.background = 'var(--ck-yellow, #ffc107)';
    dot.style.animation = 'none';
    setTimeout(() => {
      dot.style.background = 'var(--ck-green, #7cffb2)';
      dot.style.animation = 'tokfree-pulse 2s infinite';
    }, 3000);
  }
}

/**
 * 根据当前 URL 切换覆盖层首页模式
 * 首页 https://chat.deepseek.com/ 时，只保留「初始化项目」按钮，隐藏其他内容
 * 同时展示首次使用提示浮窗（居中）
 */
function shouldShowOnboarding(provider, isHome) {
  if (!provider) return false;
  // 登录页：不弹（方法缺失/抛异常一律视为"未知"，绝不误弹）
  let onLogin = false;
  try { if (typeof provider.isLoginPage === 'function') onLogin = !!provider.isLoginPage(); } catch (_) { onLogin = false; }
  if (onLogin) return false;
  // 有主界面检测能力：以它为准（已登录且进入对话页才弹）
  try {
    if (typeof provider.isMainInterface === 'function') return !!provider.isMainInterface();
  } catch (_) { return false; }
  // 无主界面检测能力：非首页即视为可用
  return !isHome;
}

function updateHomeMode() {
  // 悬浮窗与新手引导均已禁用：仅保留登录按钮状态更新
  updateLoginButton();
}

/**
 * 显示首次使用提示浮窗（居中）
 */
function showFirstTimeDialog() {
  // 新手引导已删除：任何页面都不再弹出首次提示浮窗
  hideFirstTimeDialog();
}

/**
 * 隐藏首次使用提示浮窗
 */
function hideFirstTimeDialog() {
  const dialog = document.getElementById('tokfree-first-time-dialog');
  if (dialog) dialog.classList.add('tokfree-hidden');
}

/**
 * 强制显示覆盖层（移除所有隐藏状态）
 * 用于兜底恢复因异常被隐藏的面板
 */
function updateLoginButton() {
  try {
    const loginBtn = document.getElementById('tokfree-btn-quick-login');
    if (!loginBtn) return;
    const provider = getProviderByUrl(window.location.href);
    let onLogin = false;
    try { if (provider && typeof provider.isLoginPage === 'function') onLogin = !!provider.isLoginPage(); } catch (_) { onLogin = false; }
    if (onLogin) loginBtn.classList.remove('tokfree-hidden');
    else loginBtn.classList.add('tokfree-hidden');
  } catch (_) {}
}

function forceShowOverlay() {
  // 悬浮窗已彻底禁用：保留空实现以防其他模块引用报错
  hideOverlay();
}

/**
 * 启动定期巡检，防止面板被意外隐藏（最小化、ESC、脚本错误等）
 * 每 5 秒检查一次，如果被隐藏则自动恢复
 */
function startOverlayWatcher() {
  // 方向 C：不再定期强制弹出面板，避免遮挡主界面。
}

module.exports = {
  dialogCompat,
  themeManager,
  initProgressiveDisclosure,
  injectCSS,
  applyTheme,
  toggleTheme,
  getSavedTheme,
  injectOverlay,
  generateId,
  formatTime,
  truncate,
  escapeHtml,
  showToast,
  showConfirmDialog,
  showAccountSelectDialog,
  setTaskStatus,
  showOverlay,
  hideOverlay,
  displayCommand,
  handleExecute,
  handleIgnore,
  addHistory,
  renderHistory,
  commandHistory,
  flashBadge,
  updateHomeMode,
  showFirstTimeDialog,
  hideFirstTimeDialog,
  forceShowOverlay,
  startOverlayWatcher,
  updateLoginButton,
};
