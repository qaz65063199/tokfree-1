/**
 * 失败自动重试引擎
 * 订阅 intercept-observer 的 tokfree-ai-error 事件，按配置退避后发送提示词，
 * 触发 AI 重新回答。成功回复会重置计数。
 *
 * 配置来源：localStorage（每窗口独立）
 *  - tokfree-retry-enabled        '1' | '0'  默认 '1'
 *  - tokfree-retry-delay-min      毫秒，默认 4000
 *  - tokfree-retry-delay-max      毫秒，默认 10000
 *  - tokfree-retry-count          普通失败次数，默认 10；负数=无限
 *  - tokfree-retry-429-delay      毫秒，默认 60000
 *  - tokfree-retry-429-count      429 次数，默认 20；负数=无限
 *  - tokfree-retry-prompt         提示词文案
 */
const { sendToChat } = require('./chat-input');
const { showToast } = require('../overlay/ui');

// onAiError / onInterceptedResponse 由 intercept-observer 提供。
// 运行时 require 并用 try-catch 兼容（该模块可能尚未导出 onAiError）。
let onAiError = null;
let onInterceptedResponse = null;
try {
  const io = require('./intercept-observer');
  if (typeof io.onAiError === 'function') onAiError = io.onAiError;
  if (typeof io.onInterceptedResponse === 'function') onInterceptedResponse = io.onInterceptedResponse;
} catch (e) {
  console.warn('[TokFree][重试] intercept-observer 尚未就绪: ' + (e && e.message));
}

const DEFAULT_PROMPT = '刚才的回复似乎中断了，请重新完整回答上一个问题。';
const DEFAULTS = {
  enabled: true,
  delayMin: 4000,
  delayMax: 10000,
  count: 10,
  delay429: 60000,
  count429: 20,
  prompt: DEFAULT_PROMPT,
};

function readConfig() {
  const cfg = Object.assign({}, DEFAULTS);
  try {
    const en = localStorage.getItem('tokfree-retry-enabled');
    if (en !== null) cfg.enabled = en === '1';
    const dmin = parseInt(localStorage.getItem('tokfree-retry-delay-min'), 10);
    if (Number.isFinite(dmin)) cfg.delayMin = dmin;
    const dmax = parseInt(localStorage.getItem('tokfree-retry-delay-max'), 10);
    if (Number.isFinite(dmax)) cfg.delayMax = dmax;
    const cnt = parseInt(localStorage.getItem('tokfree-retry-count'), 10);
    if (Number.isFinite(cnt)) cfg.count = cnt;
    const d429 = parseInt(localStorage.getItem('tokfree-retry-429-delay'), 10);
    if (Number.isFinite(d429)) cfg.delay429 = d429;
    const c429 = parseInt(localStorage.getItem('tokfree-retry-429-count'), 10);
    if (Number.isFinite(c429)) cfg.count429 = c429;
    const p = localStorage.getItem('tokfree-retry-prompt');
    if (p) cfg.prompt = p;
  } catch (e) { /* ignore */ }
  return cfg;
}

function pickDelay(min, max) {
  if (!Number.isFinite(min) || min < 0) min = 0;
  if (!Number.isFinite(max) || max < min) max = min;
  if (min === max) return min;
  return Math.floor(Math.random() * (max - min)) + min;
}

/** 取当前页面 URL 对应的会话 ID（无则返回 null） */
function getCurrentSessionId() {
  try {
    const { getProviderByUrl } = require('../../providers');
    const provider = getProviderByUrl(window.location.href);
    if (provider && typeof provider.extractSessionId === 'function') {
      return provider.extractSessionId(window.location.href) || null;
    }
  } catch (_) { /* ignore */ }
  return null;
}

let normalCount = 0;
let count429 = 0;
let pending = null;
let compacting = false;

function setCompacting(v) {
  compacting = !!v;
}

function clearPending() {
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  if (pending.countdownTimer) clearInterval(pending.countdownTimer);
  pending = null;
  const box = document.getElementById('tokfree-retry-countdown');
  if (box) box.classList.add('tokfree-hidden');
}

function onSuccess() {
  normalCount = 0;
  count429 = 0;
  clearPending();
}

function cancelPending() {
  clearPending();
  showToast('已取消自动重试', 2000);
}

function showCountdown(totalMs) {
  const box = ensureCountdownBox();
  const textEl = box.querySelector('#tokfree-retry-countdown-text');
  const cancelBtn = box.querySelector('#tokfree-retry-cancel');
  cancelBtn.onclick = cancelPending;
  box.classList.remove('tokfree-hidden');

  let remain = Math.ceil(totalMs / 1000);
  function render() {
    if (textEl) textEl.textContent = '请求失败，' + remain + ' 秒后自动重试...';
  }
  render();
  const cd = setInterval(() => {
    remain -= 1;
    if (remain <= 0) { clearInterval(cd); return; }
    render();
  }, 1000);
  return cd;
}

function ensureCountdownBox() {
  let box = document.getElementById('tokfree-retry-countdown');
  if (box) return box;
  box = document.createElement('div');
  box.id = 'tokfree-retry-countdown';
  box.className = 'tokfree-retry-countdown tokfree-hidden';
  box.innerHTML =
    '<div class="tokfree-retry-countdown-inner">' +
    '  <span id="tokfree-retry-countdown-text">等待重试...</span>' +
    '  <button id="tokfree-retry-cancel" class="tokfree-btn-text">取消</button>' +
    '</div>';
  document.body.appendChild(box);
  return box;
}

/**
 * 纯函数：判定错误是否应重试，以及重试延迟（无副作用，便于单测）。
 * @param {object} detail 错误详情，可能含 httpStatus / sessionId
 * @param {object} cfg readConfig() 的结果
 * @param {object} state { normalCount, count429 } 当前计数
 * @param {boolean} [isSameSession] 会话是否一致（detail.sessionId 存在时由调用方传入）
 * @returns {{retry:boolean, kind:('429'|'normal'|null), delay:number, reason:string}}
 */
function decideRetry(detail, cfg, state, isSameSession) {
  state = state || {};
  // 会话校验：错误发生时的会话与当前会话不一致 → 忽略（旧会话的延迟失败）
  if (detail && detail.sessionId !== undefined && isSameSession === false) {
    return { retry: false, kind: null, delay: 0, reason: '会话已切换，忽略旧会话错误' };
  }

  // 限流判定：HTTP 429 或 API 业务码 40029（DeepSeek「操作过于频繁」常以 200 + code 返回）
  const bizCode = detail && detail.bizCode;
  const is429 = !!(detail && (detail.httpStatus === 429 || bizCode === 40029 || bizCode === '40029'));
  const normalCount = state.normalCount || 0;
  const count429 = state.count429 || 0;

  if (is429) {
    if (cfg.count429 >= 0 && count429 >= cfg.count429) {
      return { retry: false, kind: '429', delay: 0, reason: '429 超限' };
    }
    const delay = Number.isFinite(cfg.delay429) ? cfg.delay429 : 60000;
    return { retry: true, kind: '429', delay: delay, reason: '429 重试' };
  }

  if (cfg.count >= 0 && normalCount >= cfg.count) {
    return { retry: false, kind: 'normal', delay: 0, reason: '普通超限' };
  }
  return { retry: true, kind: 'normal', delay: pickDelay(cfg.delayMin, cfg.delayMax), reason: '普通重试' };
}

function handleError(detail) {
  const cfg = readConfig();
  if (!cfg.enabled) return;
  if (compacting) return;

  let isSameSession;
  let curSession;
  if (detail && detail.sessionId !== undefined) {
    curSession = getCurrentSessionId();
    isSameSession = (detail.sessionId === curSession);
  }

  const decision = decideRetry(detail, cfg, { normalCount: normalCount, count429: count429 }, isSameSession);
  if (!decision.retry) {
    if (decision.kind === null) {
      console.log('[TokFree][重试] 会话已切换（' + detail.sessionId + ' -> ' + curSession + '），忽略旧会话的错误');
      return;
    }
    if (decision.kind === '429') {
      showToast('429 超限重试已达上限（' + cfg.count429 + ' 次），停止自动重试', 4000);
    } else {
      showToast('自动重试已达上限（' + cfg.count + ' 次），停止自动重试', 4000);
    }
    clearPending();
    return;
  }

  // 计数副作用（判定逻辑已在 decideRetry 完成）
  if (decision.kind === '429') count429++;
  else normalCount++;

  clearPending();
  const is429 = decision.kind === '429';
  const delay = decision.delay;

  const cdTimer = showCountdown(delay);
  const timer = setTimeout(() => {
    const box = document.getElementById('tokfree-retry-countdown');
    if (box) box.classList.add('tokfree-hidden');
    if (pending && pending.countdownTimer) clearInterval(pending.countdownTimer);
    pending = null;
    try {
      sendToChat(cfg.prompt, is429 ? '重试(429)' : '重试', 300);
    } catch (e) {
      console.error('[TokFree][重试] 发送提示词失败: ' + e.message);
    }
  }, delay);

  pending = { kind: is429 ? '429' : 'normal', timer: timer, countdownTimer: cdTimer, remainMs: delay };
}

let started = false;
function startRetryEngine() {
  if (started) return;
  started = true;
  if (typeof onAiError === 'function') onAiError(handleError);
  else console.warn('[TokFree][重试] onAiError 不可用，错误事件将不会被订阅');
  if (typeof onInterceptedResponse === 'function') onInterceptedResponse(() => onSuccess());
  console.log('[TokFree][重试] 自动重试引擎已启动');
}

module.exports = { startRetryEngine, setCompacting, readConfig, DEFAULT_PROMPT, pickDelay, decideRetry };

