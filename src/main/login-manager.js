'use strict';

/**
 * 登录管理器（自动检测登录失效 → 用绑定账号自动重登；失败通知 UI 选号）
 *
 * 触发：窗口 did-finish-load 后延迟检查；也可定时检查。
 * 依赖：account-pool（取账号密码）、profile-manager（读绑定）、providers（登录选择器）。
 */
const windowState = require('./window');
const profileManager = require('./profile-manager');
const accountPool = require('./account-pool');

const RETRY_DELAY = 4000; // 提交后等待检测结果的毫秒
const LOGIN_WATCH_INTERVAL = 3000; // 持续监测登录页的轮询间隔

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 解析窗口所属 provider：优先 ctx.providerId；为空时按当前 URL 反推并回写 profile。
 * 多窗口切换平台后 providerId 可能为空/不一致，导致 getProvider 返回 null 而静默跳过登录处理。
 */
function resolveProvider(ctx) {
  if (!ctx) return null;
  let provider = null;
  if (ctx.providerId) {
    try { provider = require('../providers').getProvider(ctx.providerId); } catch (_) { provider = null; }
  }
  if (!provider && ctx.win && !ctx.win.isDestroyed()) {
    try {
      const url = ctx.win.webContents.getURL();
      provider = require('../providers').getProviderByUrl(url);
      if (provider && provider.id) {
        // 顺便回写 profile.providerId（不改 partition，避免与已建 partition 冲突），并同步内存 ctx
        try { profileManager.updateProfile(ctx.profileId, { providerId: provider.id }); } catch (_) {}
        ctx.providerId = provider.id;
      }
    } catch (_) { /* 反推失败：保持 provider=null */ }
  }
  return provider;
}

// ========== 持续监测（每个窗口一个轮询定时器）==========
const _watchers = new Map();   // profileId -> intervalId
// 同一窗口同一时刻只允许一次登录检查（避免轮询重叠触发重复提交）
const _loginInFlight = new Set();

/** 启动某窗口的登录页持续监测（幂等；SPA 内退出登录也能捕获） */
function startLoginWatcher(profileId) {
  if (!profileId || _watchers.has(profileId)) return;
  const timer = setInterval(() => {
    const ctx = windowState.getWindowByProfileId(profileId);
    if (!ctx || !ctx.win || ctx.win.isDestroyed()) { stopLoginWatcher(profileId); return; }
    // 已在检查中 → 跳过本轮，避免重叠
    if (_loginInFlight.has(profileId)) return;
    // 快速探测：先看是否已进入主界面（有可见聊天框），是则直接跳过——
    // 双保险，避免 isLoginPage 因页面结构差异误报
    const provider = resolveProvider(ctx);
    if (!provider || typeof provider.isLoginPage !== 'function') return;
    callInPage(ctx.win, provider, 'isMainInterface').then((isMain) => {
      if (isMain === true) {
        // 已登录主界面：无需操作
        return;
      }
      return callInPage(ctx.win, provider, 'isLoginPage').then((onLogin) => {
        if (onLogin === true) {
          checkAndRelogin(profileId).catch((e) => console.error('[LoginManager] 监测触发检查失败:', e.message));
        }
      });
    }).catch(() => {});
  }, LOGIN_WATCH_INTERVAL);
  _watchers.set(profileId, timer);
  console.log('[LoginManager] 已启动登录页监测 profile=' + profileId);
}

/** 停止某窗口的监测 */
function stopLoginWatcher(profileId) {
  const t = _watchers.get(profileId);
  if (t) { clearInterval(t); _watchers.delete(profileId); }
}

/** 当前页面是否有密码输入框（=已在「账号密码登录」表单） */
async function hasPasswordInput(win) {
  try {
    return await win.webContents.executeJavaScript("!!Array.from(document.querySelectorAll('input[type=password]')).find(function(e){return e.offsetWidth>0&&e.offsetHeight>0;})", true);
  } catch (e) { return false; }
}

/** 轮询等待密码输入框出现，最多 timeoutMs 毫秒（用于等「密码登录」表单切换完成） */
async function waitForPasswordInput(win, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasPasswordInput(win)) return true;
    await sleep(400);
  }
  return false;
}

/**
 * 检测窗口登录状态（带等待，避免页面加载中误判）
 * @returns {Promise<'main'|'login'|'loading'>}
 *   'main' 已登录主界面（无需操作）
 *   'login' 确认在登录页（表单已就绪）
 *   'loading' 页面未就绪（静默，不动作）
 */
async function detectLoginState(win, provider, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  let sawLoginForm = false;
  while (Date.now() < deadline) {
    const isMain = await callInPage(win, provider, 'isMainInterface');
    if (isMain === true) return 'main';
    const isLogin = await callInPage(win, provider, 'isLoginPage');
    if (isLogin === true) sawLoginForm = true;
    await sleep(500);
  }
  return sawLoginForm ? 'login' : 'loading';
}

/** 把 provider 的某个纯函数序列化后在页面里执行并取返回值 */
async function callInPage(win, provider, fnName, args) {
  const fn = provider[fnName];
  if (typeof fn !== 'function') return null;
  const argsStr = (args || []).map(a => JSON.stringify(a)).join(',');
  let fnStr = String(fn).trim();
  // ⚠️ 关键：provider 的方法是「对象方法简写」，toString() 得到 "isLoginPage() {...}"，
  // 直接拼成 "(isLoginPage() {...})()" 是无效 JS（Unexpected token '{'），会静默失败。
  // 需转成 "function() {...}"。
  if (/^(async\s+)?[a-zA-Z_$][\w$]*\s*\([^)]*\)\s*\{/.test(fnStr)) {
    fnStr = fnStr.replace(/^(async\s+)?[a-zA-Z_$][\w$]*\s*\(/, (m, a) => (a || '') + 'function(');
  }
  const src = '(' + fnStr + ')(' + argsStr + ')';
  try {
    return await win.webContents.executeJavaScript(src, true);
  } catch (e) {
    console.error('[LoginManager] callInPage(' + fnName + ') 失败:', e && e.message);
    return null;
  }
}

/** 在页面里用原生 setter 填值并派发 input 事件（React 受控组件需要） */
async function fillInput(win, selectorOrFinder, value) {
  const code = `(function(){
    var el = ${selectorOrFinder};
    if (!el) return false;
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
  try { return await win.webContents.executeJavaScript(code, true); } catch (e) { return false; }
}

/** 点击元素（实测：DeepSeek 等 React 站点必须用原生 element.click()，鼠标事件序列无效） */
async function clickEl(win, selectorOrFinder) {
  const code = `(function(){
    var el = ${selectorOrFinder};
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center' }); } catch(e){}
    // 优先原生 click（React 受控组件实测有效）；失败再兜底鼠标事件序列
    try { el.click(); return 'native'; } catch(e){}
    var r = el.getBoundingClientRect();
    var o = { bubbles: true, cancelable: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2, view: window };
    try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch(e){}
    el.dispatchEvent(new MouseEvent('mousedown', o));
    try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch(e){}
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
    return 'events';
  })()`;
  try { return await webContentsExecute(win, code); } catch (e) { return false; }
}

/** 薄封装：执行 JS（便于统一处理） */
async function webContentsExecute(win, code) {
  return await win.webContents.executeJavaScript(code, true);
}

// 弹窗去重：同一窗口 N 秒内只弹一次
const _lastNotifyAt = new Map();
const NOTIFY_DEDUP_MS = 60000;

/** 带去重的失败通知 */
function notifyReloginFailedOnce(profileId, reason) {
  const last = _lastNotifyAt.get(profileId) || 0;
  if (Date.now() - last < NOTIFY_DEDUP_MS) return;
  _lastNotifyAt.set(profileId, Date.now());
  notifyReloginFailed(profileId, reason);
}

/** 自动登录带重试（仅 PAGE_NOT_READY 重试，避免重复提交） */
async function doLoginWithRetry(profileId, account, maxRetry) {
  let lastErr = '';
  for (let i = 0; i <= (maxRetry || 0); i++) {
    const res = await doLogin(profileId, account);
    if (res.success) return res;
    lastErr = res.error || '';
    if (lastErr === 'PAGE_NOT_READY' && i < maxRetry) { await sleep(3000); continue; }
    break;
  }
  if (lastErr === 'PAGE_NOT_READY') lastErr = '登录页未就绪（可能网络慢）';
  return { success: false, error: lastErr };
}

// 选号弹窗去重：同窗口 N 秒内只弹一次（避免 watcher 轮询反复打扰）
const _lastSelectAt = new Map();
const SELECT_DEDUP_MS = 60000;

/** 账号池里是否有「该平台」且「有密码」的账号（用于决定是否自动弹选号框） */
function hasMatchingAccounts(providerId) {
  if (!providerId) return false;
  try {
    // 大小写不敏感：拉全量后自行按小写比较（不改 account-pool 存储结构与 listAccounts 精确过滤语义）
    const all = accountPool.listAccounts();
    const target = String(providerId).toLowerCase();
    return all.some(a => a && a.hasPassword && String(a.providerId || '').toLowerCase() === target);
  } catch (_) { return false; }
}

/**
 * 通知 renderer：需要用户从账号池选择账号（弹真正的选择弹窗）
 * @param {string} profileId
 * @param {string} reason 展示给用户的原因
 * @param {string} [providerId] 平台标识；缺省时从窗口上下文取。用于让 renderer 只列该平台账号
 */
function notifyNeedAccountSelect(profileId, reason, providerId) {
  const ctx = windowState.getWindowByProfileId(profileId);
  let pid = providerId || (ctx && ctx.providerId) || null;
  // providerId 为空时按当前 URL 反推（与 checkAndRelogin 一致），避免永远不弹选号框
  if (!pid && ctx && ctx.win && !ctx.win.isDestroyed()) {
    try {
      const p = require('../providers').getProviderByUrl(ctx.win.webContents.getURL());
      if (p && p.id) pid = p.id;
    } catch (_) {}
  }
  // 只有账号池里存在「该平台 + 有密码」的账号时才弹选号框，避免弹空列表
  if (hasMatchingAccounts(pid)) {
    // 去重：60 秒内只弹一次（用户取消后不会立刻再弹）
    const last = _lastSelectAt.get(profileId) || 0;
    if (Date.now() - last >= SELECT_DEDUP_MS) {
      _lastSelectAt.set(profileId, Date.now());
      if (ctx && ctx.win && !ctx.win.isDestroyed()) {
        try { ctx.win.webContents.send('account-need-select', { profileId, reason, providerId: pid }); } catch (_) {}
      }
    }
  }
  // Worker 停在登录页无法自己回报 → 主进程代它向主 Agent 发 ASK
  reportToMaster(profileId, reason);
}

/** 通知 renderer：自动登录失败，请用户选其他账号 */
function notifyReloginFailed(profileId, reason) {
  const ctx = windowState.getWindowByProfileId(profileId);
  if (ctx && ctx.win && !ctx.win.isDestroyed()) {
    try { ctx.win.webContents.send('account-relogin-failed', { profileId, reason }); } catch (_) {}
  }
  // 关键：Worker 停在登录页时它自己无法发暗号回报（没有聊天框），
  // 由主进程代替它向主 Agent 发一条 ASK 回报，避免主 Agent 一直干等。
  reportToMaster(profileId, reason);
}

/** 代替卡在登录页的 Worker，向主 Agent 回报登录失效（ASK 级） */
function reportToMaster(profileId, reason) {
  try {
    const taskManager = require('./team/task-manager');
    const task = taskManager.getActiveTaskByProfile(profileId);
    if (!task) return; // 该窗口当前没有活跃任务，无需回报
    const content = '【登录失效】该窗口已退出登录（' + (reason || '需人工处理') +
      '）。窗口停留在登录页，无法继续任务。请在账号池绑定账号后重试，或人工登录后恢复。';
    taskManager.appendReport(task.id, { level: 'ASK', content });
    taskManager.updateTaskStatus(task.id, 'WAITING_MASTER', content);
    const { enqueue } = require('./team/report-queue');
    enqueue({ taskId: task.id, level: 'ASK', content });
    console.log('[LoginManager] 已代替 Worker 向主 Agent 回报登录失效 profile=' + profileId);
  } catch (e) {
    console.error('[LoginManager] 回报主 Agent 失败:', e.message);
  }
}

/**
 * 用指定账号在该窗口执行自动登录
 * @returns {Promise<{success:boolean, error?:string}>}
 */
async function doLogin(profileId, account) {
  const ctx = windowState.getWindowByProfileId(profileId);
  if (!ctx || !ctx.win || ctx.win.isDestroyed()) return { success: false, error: '窗口不存在' };
  const win = ctx.win;
  const provider = resolveProvider(ctx);
  if (!provider) return { success: false, error: '未找到平台 provider' };
  if (typeof provider.isLoginPage !== 'function') return { success: false, error: '该平台暂不支持自动登录' };

  // ========== 时序（关键）：DeepSeek 登录页默认是「手机验证码登录」，
  // 必须先把表单切到「账号密码登录」（密码框出现）后，才能填账密。==========

  // 1. 先确认当前是否已在「账密表单」（有密码框）
  let hasPwd = await hasPasswordInput(win);

  // 2. 若不在账密表单：点「密码登录」入口，并**轮询等待密码框出现**
  if (!hasPwd) {
    // 候选入口选择器（含 a/span 兜底），文案去空白后等值匹配，多个命中取最后一个（最内层叶子）
    const entryFinder = `(function(){var els=Array.from(document.querySelectorAll('button, [role=button], div.ds-button, a, span'));var hit=null;for(var i=0;i<els.length;i++){var el=els[i];if(!(el.offsetWidth>0&&el.offsetHeight>0))continue;var t=(el.textContent||'').replace(/\s+/g,'');if(t==='密码登录'||t==='账号密码登录'||t==='密码/账号登录'||t==='使用密码登录')hit=el;}return hit;})()`;
    let clicked = await clickEl(win, entryFinder);
    if (!clicked) {
      // 第一轮找不到入口：尝试展开「其他登录方式 / 更多登录方式 / 其他方式」后再重找
      const expandFinder = `(function(){var els=Array.from(document.querySelectorAll('button, [role=button], div.ds-button, a, span'));var hit=null;for(var i=0;i<els.length;i++){var el=els[i];if(!(el.offsetWidth>0&&el.offsetHeight>0))continue;var t=(el.textContent||'').replace(/\s+/g,'');if(t==='其他登录方式'||t==='更多登录方式'||t==='其他方式')hit=el;}return hit;})()`;
      const expanded = await clickEl(win, expandFinder);
      if (expanded) {
        await sleep(800);
        clicked = await clickEl(win, entryFinder);
      }
    }
    if (!clicked) return { success: false, error: 'PAGE_NOT_READY' }; // 页面没渲染好，可重试
    // 等表单真正切换过去（最多 8 秒）
    hasPwd = await waitForPasswordInput(win, 8000);
    if (!hasPwd) return { success: false, error: '点击「密码登录」后未出现密码输入框（切换失败）' };
  }

  // 3. 确认已在账密表单，填用户名（严格限定：存在密码框时的文本输入框）
  const userFinder = `(function(){
    var pwd = document.querySelector('input[type=password]');
    if (!pwd) return null;
    var all = Array.from(document.querySelectorAll('input'));
    var texts = all.filter(function(el){ return el.type==='text'||el.type==='email'||el.type==='tel'; });
    var byPh = texts.find(function(el){ var ph=el.placeholder||''; return ph.indexOf('邮箱')>=0||ph.indexOf('手机')>=0||ph.indexOf('账号')>=0||ph.indexOf('Email')>=0; });
    return byPh || texts[0] || null;
  })()`;
  const okUser = await fillInput(win, userFinder, account.username || '');
  await sleep(300);

  // 3. 填密码
  const passFinder = `document.querySelector('input[type=password]')`;
  const okPass = await fillInput(win, passFinder, account.password || '');
  await sleep(300);

  if (!okUser || !okPass) return { success: false, error: '未找到账号/密码输入框' };

  // 4. 提交
  const submitFinder = `(function(){var b=Array.from(document.querySelectorAll('button, [role=button], div.ds-button'));for(var i=0;i<b.length;i++){var t=(b[i].textContent||'').trim();if((t==='登录'||t==='登 录'||t==='Log in'||t==='Login')&&!b[i].disabled)return b[i];}return null;})()`;
  await clickEl(win, submitFinder);

  // 5. 等待并检测结果
  await sleep(RETRY_DELAY);
  const stillLogin = await callInPage(win, provider, 'isLoginPage');
  if (stillLogin === false) {
    try { accountPool.markUsed(account.id); } catch (_) {}
    return { success: true };
  }
  const errText = await callInPage(win, provider, 'detectLoginError');
  return { success: false, error: errText || '登录后仍在登录页（可能需验证码或选择器失效）' };
}

/**
 * 检查并在需要时自动重登
 */
async function checkAndRelogin(profileId) {
  // 同一窗口同一时刻只允许一次检查（防轮询重叠导致重复提交）
  if (_loginInFlight.has(profileId)) return { relogged: false, inFlight: true };
  _loginInFlight.add(profileId);
  try {
    const ctx = windowState.getWindowByProfileId(profileId);
    if (!ctx || !ctx.win || ctx.win.isDestroyed()) return { relogged: false };
    const provider = resolveProvider(ctx);
    if (!provider || typeof provider.isLoginPage !== 'function') return { relogged: false };

    // 关键：等待页面稳定后再判断，避免"还在加载就误判登录页"
    const state = await detectLoginState(ctx.win, provider, 15000);
    if (state === 'main') return { relogged: false, main: true };
    if (state === 'loading') return { relogged: false, loading: true };

    // state === 'login'（确认在登录页）
    const p = profileManager.getProfileById(profileId);
    const accountId = p && p.account ? p.account.accountId : null;

    // 未绑定：通知 UI 弹「账号池选择」弹窗（不再静默）
    if (!accountId) {
      notifyNeedAccountSelect(profileId, '未绑定账号，请从账号池选择');
      return { relogged: false, noBinding: true, needSelect: true };
    }

    const account = accountPool.getAccountWithPassword(accountId);
    if (!account || !account.password) {
      // 绑定了但无密码：同样弹选择（换一个有密码的账号）
      notifyNeedAccountSelect(profileId, '绑定账号无密码，请重新选择');
      reportToMaster(profileId, '绑定账号无密码');
      return { relogged: false, noPassword: true, needSelect: true };
    }

    const res = await doLoginWithRetry(profileId, account, 2);
    if (res.success) return { relogged: true };
    // 已绑定的自动登录失败 → 也弹选择（让用户换号）
    notifyNeedAccountSelect(profileId, res.error || '自动登录失败');
    return { relogged: false, error: res.error, needSelect: true };
  } finally {
    _loginInFlight.delete(profileId);
  }
}

/**
 * 用户从选号弹窗选择其他账号后重试
 */
async function retryWithAccount(profileId, accountId) {
  if (!profileId || !accountId) return { success: false, error: '缺少参数' };
  const account = accountPool.getAccountWithPassword(accountId);
  if (!account) return { success: false, error: '账号不存在' };
  // 顺便绑定到该窗口
  try { profileManager.updateProfile(profileId, { account: { accountId } }); } catch (_) {}
  // 清除去重状态（用户主动选择了账号，允许后续再次触发）
  _lastSelectAt.delete(profileId);
  const res = await doLogin(profileId, account);
  if (res.success) {
    try { accountPool.markUsed(accountId); } catch (_) {}
  }
  return res;
}

/**
 * 窗口加载后延迟检查（供 window.js / index.js 调用）
 */
function scheduleCheck(profileId, delayMs) {
  setTimeout(() => {
    checkAndRelogin(profileId).catch((e) => console.error('[LoginManager] 检查失败:', e.message));
  }, typeof delayMs === 'number' ? delayMs : 6000);
}

module.exports = { checkAndRelogin, retryWithAccount, scheduleCheck, doLogin, detectLoginState, startLoginWatcher, stopLoginWatcher };
