/**
 * 看门狗（Watchdog）—— AI 生命监护
 *
 * 用 TokFree 原生能力实现，替代外部 Python 版看门狗：
 * - 心跳：窗口的 AI 每有活动（收发消息/工具执行/JS 执行）即刷新心跳
 * - 停顿检测：心跳超时（默认 4 分钟）判定 AI 停了
 * - 自动唤醒：向该窗口发送唤醒语，让 AI 继续
 * - 限流保护：识别到限流文案则进入冷却（默认 15 分钟）不再打扰
 * - busy 保护：长任务期间自动续心跳、不唤醒
 * - 暂停/恢复/启用/禁用
 *
 * 配置持久化于 userData/watchdog-config.json。
 */
const { app, powerSaveBlocker, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const eventLog = require('./event-log');
const workerActivity = require('./worker-activity');
const { logger } = require('../core/logger');

const DEFAULT_CONFIG = {
  enabled: true,
  paused: false,
  interval: 240,     // 秒：纯静默兜底（思考中/无信号时用长值，避免误判）；真中断走 interruptInterval
  interruptInterval: 30, // 秒：已检测到"疑似中断"后，多少秒未恢复才催促（原 5s 太激进：AI 思考/按钮闪烁即被误判中断，导致疯狂催）
  minGap: 120,       // 秒：两次唤醒最小间隔（原 5s 太短，会连续催）
  cooldown: 90,      // 秒：命中限流后冷却时长（原 900s 过长，误判一次 15 分钟不催）
  busyMax: 1800,     // 秒：busy 标记最长有效（超时视为 AI 已崩）
  maxArmSecs: 1200,  // 秒：单次监护最长时长；超时自动解除，防止 arm 泄漏导致误唤醒
  staleHeartbeatSecs: 45, // 秒：expectingReply 但心跳停滞超此值（且非 busy）→ 监护泄漏，自动解除（正常心跳 2s/次，45s 已充足余量）
  confirmDelay: 120, // 秒：AI 正常回复后，等待多久发送"完成确认"催促（原 5s 太激进：AI 还在做事就催）
  maxNags: 2,        // 次：连续"完成确认"催促上限（原 5 次偏多，改成 2 次，减少打扰）
  doneKeyword: '紫电青霜-7391', // 暗号：AI 回复中出现即视为任务完成，停止催促
  confirmMsg: '这个阶段性任务完成了吗？如果还没完成，请继续推进，不要停在半途；如果已经全部完成，请在回复末尾附上暗号【{keyword}】，我看到后就不再催促。',
  msg: '你怎么停下来了？是完成了，还是卡住了？如果任务还没完成，请从中断处继续。',
  // 限流关键词：必须用「完整句式」，避免正常对话里夹带"限制/频繁"就被误判。
  // 教训：曾用 '限制'、'频繁' 等单词，导致 AI 回复里复述"限流相关代码"即进入 900s 冷却，
  // 看门狗长时间不催，表现为"怎么都不触发"。
  ratelimitKw: [
    '请求过于频繁', '请求次数过多', '您已达到', '达到使用限制', '今日使用次数',
    '请稍后再试', '请稍后重试', '服务器繁忙', '服务繁忙', '系统繁忙',
    'rate limit exceeded', 'too many requests', 'please try again later',
    'usage limit', 'quota exceeded',
  ],
};

let config = Object.assign({}, DEFAULT_CONFIG);
let configFile = null;

// 秒：busy 标记期间超过此秒数无工具活动 → 视为残留（clearBusy 未送达），自动清除
const BUSY_STALE_SECS = 120;

// ========== 电源保持（防止系统休眠中断长任务）==========
// 仅在有"活跃监护任务"（任意 profile expectingReply）时持锁，空闲自动释放，避免一直不让系统睡眠。
// prevent-app-suspension：阻止系统休眠，但允许息屏（锁屏场景正合适）。
let blockerId = null;
let blockerHeld = false;

function anyExpecting() {
  for (const st of states.values()) {
    if (st.expectingReply) return true;
  }
  return false;
}

function syncPowerBlocker() {
  const shouldHold = anyExpecting();
  if (shouldHold === blockerHeld) return;
  blockerHeld = shouldHold;
  try {
    if (shouldHold) {
      if (powerSaveBlocker && typeof powerSaveBlocker.start === 'function') {
        blockerId = powerSaveBlocker.start('prevent-app-suspension');
        logger.info('[Watchdog] 已开启电源保持（防止系统休眠中断任务），id=' + blockerId);
      }
    } else {
      if (blockerId !== null && powerSaveBlocker && typeof powerSaveBlocker.stop === 'function') {
        powerSaveBlocker.stop(blockerId);
        logger.info('[Watchdog] 已释放电源保持');
      }
      blockerId = null;
    }
  } catch (err) {
    logger.error('[Watchdog] 电源保持操作失败:', err.message);
  }
}

// 电源/锁屏事件日志（便于排查锁屏期间的行为）
let powerMonitorBound = false;
function setupPowerMonitor() {
  if (powerMonitorBound || !powerMonitor || typeof powerMonitor.on !== 'function') return;
  powerMonitorBound = true;
  try {
    powerMonitor.on('suspend', () => logger.info('[Watchdog] 系统即将休眠（任务将暂停）'));
    powerMonitor.on('resume', () => logger.info('[Watchdog] 系统已从休眠恢复'));
    powerMonitor.on('lock-screen', () => logger.info('[Watchdog] 系统锁屏'));
    powerMonitor.on('unlock-screen', () => logger.info('[Watchdog] 系统解锁'));
  } catch (err) {
    logger.error('[Watchdog] 注册电源事件失败:', err.message);
  }
}
// profileId -> { lastHeartbeat, busyUntil, busyNote, lastWake, cooldownUntil, rateLimitHit }
const states = new Map();
let timer = null;
let onWake = null;

function getConfigFile() {
  if (!configFile) {
    configFile = path.join(app.getPath('userData'), 'watchdog-config.json');
  }
  return configFile;
}

function loadConfig() {
  try {
    const f = getConfigFile();
    if (fs.existsSync(f)) {
      const saved = JSON.parse(fs.readFileSync(f, 'utf-8'));
      config = Object.assign({}, DEFAULT_CONFIG, saved);
    }
  } catch (err) {
    logger.error('[Watchdog] 读取配置失败:', err.message);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(getConfigFile(), JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    logger.error('[Watchdog] 写入配置失败:', err.message);
  }
}

function randKeyword() {
  var L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  var D = '0123456789';
  var a = '', b = '';
  for (var i = 0; i < 4; i++) a += L.charAt(Math.floor(Math.random() * L.length));
  for (var j = 0; j < 4; j++) b += D.charAt(Math.floor(Math.random() * D.length));
  return a + '-' + b;
}
function getDoneKeyword(profileId) {
  var st = getState(profileId);
  if (!st.doneKeyword) st.doneKeyword = config.doneKeyword || randKeyword();
  return st.doneKeyword;
}

function getState(profileId) {
  if (!states.has(profileId)) {
    states.set(profileId, {
      // 0 表示"从未活跃"：新窗口/闲置窗口不纳入停顿检测，避免误唤醒
      lastHeartbeat: 0,
      expectingReply: false,
      // 是否已检测到中断/截断（流结束但未收到正常完成信号）：用更短超时催促
      interrupted: false,
      // 看门狗模式：'interrupt'（中断/静默监护）| 'confirm'（完成确认催促）
      mode: 'interrupt',
      // 连续"完成确认"催促次数
      nagCount: 0,
      // 中断催促次数（自本次 arm 起累计）
      interruptCount: 0,
      // 下一次"完成确认"催促的触发时间戳（0 表示无）
      pendingConfirmAt: 0,
      armAt: 0,
      busyUntil: 0,
      busyNote: '',
      lastWake: 0,
      doneKeyword: '',  // 本 profile 当前随机暗号（新任务时轮换）
      cooldownUntil: 0,
      rateLimitHit: '',
      // 账号被禁言/封禁（页面提示；由 preload 检测上报）
      bannedSince: 0,      // 检测到的时间戳；0=未禁言
      bannedUntil: 0,      // 解禁时间戳；0=未知
      banText: '',         // 简短描述（含到期时间）
      banKeyword: '',      // 命中的关键词
    });
  }
  return states.get(profileId);
}

/** 记录账号被禁言/封禁（preload 检测到页面提示时调用） */
function noteBanned(profileId, info) {
  if (!profileId) return;
  const st = getState(profileId);
  const i = info || {};
  st.bannedSince = Date.now();
  st.bannedUntil = i.until || 0;
  st.banText = i.text || '';
  st.banKeyword = i.keyword || '';
}

/** 清除禁言状态（页面提示消失时调用） */
function clearBanned(profileId) {
  const st = states.get(profileId);
  if (!st || !st.bannedSince) return;
  st.bannedSince = 0;
  st.bannedUntil = 0;
  st.banText = '';
  st.banKeyword = '';
}

/** 注册窗口（不激活检测；touch 后才开始计时） */
function register(profileId) {
  if (!profileId) return;
  getState(profileId);
}

/** 标记"已发出请求、等待 AI 回复"（进入监护，开始计时） */
function arm(profileId, reset) {
  if (!profileId) return;
  const st = getState(profileId);
  const doReset = reset !== false; // 默认重置（用户主动发送）；中途消息（工具回传/看门狗催促）传 false
  // 已在监护中则只刷新心跳，不重置 armAt（防止高频发送无限延长监护）
  if (!st.expectingReply) st.armAt = Date.now();
  st.expectingReply = true;
  st.lastHeartbeat = Date.now();
  if (doReset) {
    st.doneKeyword = randKeyword(); // 新任务轮换随机暗号，防 AI 记忆偷懒
    st.interrupted = false;
    st.mode = 'interrupt';
    st.nagCount = 0;
    st.interruptCount = 0;
    st.pendingConfirmAt = 0;
  }
  syncPowerBlocker();
}

/**
 * 标记"已检测到中断/截断"（流结束但未收到正常完成信号）：
 * 保持监护，并用更短的 interruptInterval 催促，而非干等 interval。
 * 也刷新心跳，从"检测到中断"这一刻重新计时。
 */
function markInterrupted(profileId) {
  if (!profileId) return;
  const st = getState(profileId);
  if (!st.expectingReply) return;
  st.interrupted = true;
  st.mode = 'interrupt';
  st.pendingConfirmAt = 0;
  st.lastHeartbeat = Date.now();
}

/**
 * 按钮回到「发送」态（本轮生成结束/中断）。
 * 若仍在监护中（且非 busy、非 confirm），说明可能漏掉了完成事件，
 * 用更短的 interruptInterval 催促，避免干等 interval（240s）。
 * 若 hook 已正常处理（disarm 或进入 confirm），此处自动忽略。
 */
function noteButtonIdle(profileId) {
  if (!profileId) return;
  const st = getState(profileId);
  if (!st.expectingReply) return;
  const now = Date.now();
  if (st.busyUntil && now < st.busyUntil) return; // 长任务中，按钮态不可靠
  if (st.mode === 'confirm') return;              // 已在完成确认流程，避免打架
  st.interrupted = true;
  st.mode = 'interrupt';
  st.pendingConfirmAt = 0;
  st.lastHeartbeat = now;
}

/** 标记"AI 已回复"（退出监护，不再计时，避免空闲误唤醒） */
function disarm(profileId) {
  if (!profileId) return;
  const st = getState(profileId);
  st.expectingReply = false;
  // 清除中断/限流残留：退出监护后这些标志已无意义，
  // 否则窗口管理面板会误显示"已中断，待恢复"（实际窗口正常）。
  st.interrupted = false;
  st.mode = 'interrupt';
  st.pendingConfirmAt = 0;
  syncPowerBlocker();
}

/**
 * AI 完成一条「纯文本回复」（无 JS 代码块、无工具调用）：
 * 进入「完成确认」模式，在 confirmDelay 秒后发送确认催促，
 * 直到收到暗号或达到 maxNags 上限。
 * @param {string} text 回复原文（用于检测暗号）
 * @returns {boolean} 是否已进入确认模式（false 表示含暗号 / 已达上限）
 */
function scheduleConfirm(profileId, text) {
  if (!profileId) return false;
  const st = getState(profileId);
  if (!st.expectingReply) return false;
  // 编排中：多 Agent 主大脑的节奏由调度器驱动，不做"完成确认"催促
  try {
    if (activeOrchestrationCheck && activeOrchestrationCheck(profileId)) {
      logger.info('[Watchdog] 该窗口正在多 Agent 编排中，跳过完成确认催促 profile=' + profileId);
      disarm(profileId);
      return false;
    }
  } catch (_) {}
  // 回复含暗号 → 任务确认完成，退出监护
  if (containsDoneKeyword(text, profileId)) {
    logger.info('[Watchdog] 检测到完成暗号，解除监护 profile=' + profileId);
    disarm(profileId);
    return false;
  }
  if (st.nagCount >= config.maxNags) {
    logger.info('[Watchdog] 完成确认已达上限（' + config.maxNags + ' 次），停止催促 profile=' + profileId);
    disarm(profileId);
    return false;
  }
  st.mode = 'confirm';
  st.interrupted = false;
  st.pendingConfirmAt = Date.now() + config.confirmDelay * 1000;
  st.lastHeartbeat = Date.now();
  syncPowerBlocker();
  return true;
}

/**
 * 「编排中」检查钩子（由 team 层注册，保持 watchdog 不直接依赖 team）。
 * 若某 profile 正在作为多 Agent 编排的主大脑（有活跃子任务），
 * 则不对它做"完成确认"催促——它的节奏由调度器驱动，避免与"去派活"信号冲突。
 * @type {(profileId:string)=>boolean}
 */
let activeOrchestrationCheck = null;
function setActiveOrchestrationCheck(fn) {
  activeOrchestrationCheck = typeof fn === 'function' ? fn : null;
}

/** 文本中是否包含完成暗号 */
function containsDoneKeyword(text, profileId) {
  if (!text || typeof text !== 'string') return false;
  const kw = getDoneKeyword(profileId);
  if (!kw) return false;
  return text.indexOf(kw) !== -1;
}

/** 刷新心跳：仅"等待回复"期间页面有活动时调用（流式渲染防误判） */
function touch(profileId) {
  if (!profileId) return;
  const st = getState(profileId);
  if (!st.expectingReply) return;
  st.lastHeartbeat = Date.now();
}

/** 标记长任务（期间不打扰，自动续心跳） */
function setBusy(profileId, note, secs) {
  const st = getState(profileId);
  st.expectingReply = true;
  const dur = typeof secs === 'number' && secs > 0 ? secs : config.busyMax;
  st.busyUntil = Date.now() + dur * 1000;
  st.busyNote = note || '';
  st.lastHeartbeat = Date.now();
  syncPowerBlocker();
}

function clearBusy(profileId) {
  const st = getState(profileId);
  st.busyUntil = 0;
  st.busyNote = '';
}

/** 记录命中限流：进入冷却 */
function noteRateLimit(profileId, hitWord) {
  if (!profileId) return;
  const st = getState(profileId);
  st.cooldownUntil = Date.now() + config.cooldown * 1000;
  st.rateLimitHit = hitWord || '';
  st.lastHeartbeat = Date.now();
}

/** 从一段文本里检测限流关键词，命中返回关键词，否则 null */
function detectRateLimit(text) {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase();
  // 只检查文本末尾一段（限流提示通常出现在回复末尾）
  const tail = lower.slice(-600);
  for (const kw of config.ratelimitKw) {
    if (tail.indexOf(String(kw).toLowerCase()) !== -1) return kw;
  }
  return null;
}

/** 组装"完成确认"催促语（把 {keyword} 替换为暗号） */
function buildConfirmMsg(profileId) {
  const kw = getDoneKeyword(profileId);
  return String(config.confirmMsg || '').replace(/\{keyword\}/g, kw);
}

/** 手动触发一次唤醒（忽略停顿检测，但仍尊重启用/暂停/限流） */
function wakeNow(profileId) {
  if (!config.enabled || config.paused) return { success: false, error: '看门狗未启用或已暂停' };
  const st = getState(profileId);
  const now = Date.now();
  if (st.cooldownUntil && now < st.cooldownUntil) {
    return { success: false, error: '处于限流冷却中，剩余 ' + Math.ceil((st.cooldownUntil - now) / 1000) + ' 秒' };
  }
  st.lastWake = now;
  st.lastHeartbeat = now;
  const wakeMsg = st.mode === 'confirm' ? buildConfirmMsg(profileId) : config.msg;
  if (onWake) onWake(profileId, wakeMsg);
  return { success: true, message: '已发送唤醒' };
}

function tick() {
  if (!config.enabled || config.paused) return;
  const now = Date.now();
  for (const [profileId, st] of states) {
    // 仅在"等待 AI 回复"期间检测（避免空闲时误唤醒）
    if (!st.expectingReply) continue;
    // 心跳老化兜底：expectingReply 但长期无心跳（hook 漏了 disarm）→ 自动解除，
    // 避免面板一直显示"思考/生成中"、看门狗反复空催。
    if (!(st.busyUntil && now < st.busyUntil)) {
      const _age = (now - st.lastHeartbeat) / 1000;
      if (_age > config.staleHeartbeatSecs) {
        logger.info('[Watchdog] 心跳停滞（' + Math.round(_age) + 's），自动解除监护 profile=' + profileId);
        st.expectingReply = false;
        st.interrupted = false;
        st.mode = 'interrupt';
        st.pendingConfirmAt = 0;
        syncPowerBlocker();
        continue;
      }
    }
    // 绝对超时兜底：单次监护超过 maxArmSecs 自动解除，防止 arm 泄漏永久挂着
    if (st.armAt && (now - st.armAt) > config.maxArmSecs * 1000) {
      logger.info('[Watchdog] 监护超时（' + config.maxArmSecs + 's），自动解除 profile=' + profileId);
      st.expectingReply = false;
      syncPowerBlocker();
      continue;
    }
    // busy 保护：长任务期间自动续心跳，不唤醒
    if (st.busyUntil && now < st.busyUntil) {
      // 真实活动兜底：busy 期间正常每次工具执行都会 workerActivity.touch(profileId)。
      // 若长期无任何工具活动，说明代码块早已结束但 clearBusy 未送达（webview 重载/异常）→ 自动解除 busy。
      const _busyAgo = workerActivity.getAgoSeconds(profileId);
      if (_busyAgo !== null && _busyAgo > BUSY_STALE_SECS) {
        logger.info('[Watchdog] busy 标记残留（' + _busyAgo + 's 无工具活动），自动清除 profile=' + profileId);
        st.busyUntil = 0;
        st.busyNote = '';
        st.expectingReply = false;
        st.interrupted = false;
        syncPowerBlocker();
        continue;
      }
      st.lastHeartbeat = now;
      continue;
    }
    // 完成确认模式：AI 已回复但未确认完成，按 confirmDelay 发送确认催促（有上限）
    if (st.mode === 'confirm') {
      if (st.nagCount >= config.maxNags) {
        logger.info('[Watchdog] 完成确认已达上限（' + config.maxNags + ' 次），停止催促 profile=' + profileId);
        st.expectingReply = false;
        st.mode = 'interrupt';
        st.pendingConfirmAt = 0;
        syncPowerBlocker();
        continue;
      }
      if (st.pendingConfirmAt && now >= st.pendingConfirmAt) {
        st.nagCount++;
        st.lastHeartbeat = now;
        st.lastWake = now;
        logger.info('[Watchdog] 发送完成确认（第 ' + st.nagCount + '/' + config.maxNags + ' 次）profile=' + profileId);
        eventLog.recordEvent({ profileId, type: 'nag', sub: 'confirm', detail: '第' + st.nagCount + '次' });
        if (onWake) onWake(profileId, buildConfirmMsg(profileId));
        // 已达上限：发完最后一次立即解除监护，不再等待
        if (st.nagCount >= config.maxNags) {
          logger.info('[Watchdog] 完成确认已达上限（' + config.maxNags + ' 次），停止催促 profile=' + profileId);
          st.expectingReply = false;
          st.mode = 'interrupt';
          st.pendingConfirmAt = 0;
          syncPowerBlocker();
          continue;
        }
        // 未达上限：等待 AI 回复；若一直不回复，则在 minGap 后重试
        st.pendingConfirmAt = now + Math.max(config.minGap, config.confirmDelay) * 1000;
      }
      continue;
    }
    const age = (now - st.lastHeartbeat) / 1000;
    // 已检测到中断/截断：用更短超时催促；纯静默无信号：维持较长的 interval
    const limit = st.interrupted ? config.interruptInterval : config.interval;
    if (age <= limit) continue;
    // 最小唤醒间隔
    if (now - st.lastWake < config.minGap * 1000) continue;
    // 限流冷却
    if (st.cooldownUntil && now < st.cooldownUntil) continue;
    // 唤醒
    st.lastWake = now;
    st.lastHeartbeat = now;
    st.interruptCount = (st.interruptCount || 0) + 1;
    logger.info('[Watchdog] 检测到停顿（' + Math.round(age) + 's），唤醒 profile=' + profileId);
    eventLog.recordEvent({ profileId, type: 'nag', sub: 'interrupt', detail: '第' + st.interruptCount + '次' });
    if (onWake) onWake(profileId, config.msg);
  }
}

/** 启动看门狗主循环 */
function start(opts) {
  onWake = (opts && opts.onWake) || null;
  loadConfig();
  setupPowerMonitor();
  if (timer) clearInterval(timer);
  // tickMs 仅供测试注入较短的检查周期；生产默认 3000ms
  const tickMs = (opts && typeof opts.tickMs === 'number' && opts.tickMs > 0) ? opts.tickMs : 3000;
  timer = setInterval(tick, tickMs);
  logger.info('[Watchdog] 已启动，interval=' + config.interval + 's, enabled=' + config.enabled);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

/** 更新配置（部分字段） */
function updateConfig(patch) {
  if (!patch || typeof patch !== 'object') return config;
  for (const k of Object.keys(patch)) {
    if (patch[k] !== undefined && patch[k] !== null) config[k] = patch[k];
  }
  saveConfig();
  return config;
}

/** 查询某 profile 状态（用于 UI/工具） */
function getStatus(profileId) {
  const st = profileId ? getState(profileId) : null;
  const now = Date.now();
  return {
    config: {
      enabled: config.enabled,
      paused: config.paused,
      interval: config.interval,
      minGap: config.minGap,
      cooldown: config.cooldown,
      busyMax: config.busyMax,
      msg: config.msg,
    },
    profile: st ? {
      expectingReply: !!st.expectingReply,
      interrupted: !!st.interrupted,
      mode: st.mode,
      nagCount: st.nagCount,
      heartbeatAge: Math.round((now - st.lastHeartbeat) / 1000),
      busy: !!(st.busyUntil && now < st.busyUntil),
      busyRemain: st.busyUntil && now < st.busyUntil ? Math.round((st.busyUntil - now) / 1000) : 0,
      busyNote: st.busyNote,
      cooldownRemain: st.cooldownUntil && now < st.cooldownUntil ? Math.round((st.cooldownUntil - now) / 1000) : 0,
      rateLimitHit: st.rateLimitHit,
      lastWake: st.lastWake,
      banned: !!st.bannedSince,
      bannedUntil: st.bannedUntil || 0,
      banText: st.banText || '',
      banKeyword: st.banKeyword || '',
    } : null,
  };
}

/** 移除某 profile 的状态（窗口关闭时） */
function forget(profileId) {
  states.delete(profileId);
  syncPowerBlocker();
}

module.exports = {
  start,
  stop,
  register,
  arm,
  disarm,
  touch,
  markInterrupted,
  noteButtonIdle,
  scheduleConfirm,
  containsDoneKeyword,
  getDoneKeyword,
  randKeyword,
  setBusy,
  clearBusy,
  noteRateLimit,
  detectRateLimit,
  noteBanned,
  clearBanned,
  wakeNow,
  updateConfig,
  setActiveOrchestrationCheck,
  getStatus,
  forget,
  getConfig: () => Object.assign({}, config),
};
