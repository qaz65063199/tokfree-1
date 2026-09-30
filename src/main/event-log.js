/**
 * 事件日志（Event Log）—— 窗口运行事件记录与统计
 *
 * 记录看门狗催促、拦截器处理、任务派发、任务完成等事件，
 * 供窗口管理面板展示「运行统计 / 日志」，服务于后续优化决策。
 *
 * 存储于 userData/event-log.json，结构：
 * {
 *   "events": [ { ts, profileId, type, sub, detail, meta } ],
 *   "daily": { [profileId]: { 'YYYY-MM-DD': { nag, intercept, dispatch, done, sent, received } } }
 * }
 *
 * - 事件限长：最多保留 500 条，超出丢弃最旧的
 * - 落盘节流：累计 20 条或距上次落盘 5 秒写入一次
 * - 会话收发（sent/received）沿用 conversation-stats.js，getSummary 聚合时读取
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const MAX_EVENTS = 500;
const FLUSH_INTERVAL_MS = 5000;
const FLUSH_THRESHOLD = 20;

// 计入 daily 的事件类型（sent/received 来自 conversation-stats，不在此列）
const COUNTED_TYPES = ['nag', 'intercept', 'dispatch', 'done'];
// daily 计数字段全集（保持结构稳定）
const DAILY_KEYS = ['nag', 'intercept', 'dispatch', 'done', 'sent', 'received'];

let EVENT_FILE = null;
let store = null;        // { events: [], daily: {} }
let dirtyCount = 0;      // 距上次落盘累计的变更数
let lastFlushAt = 0;     // 上次落盘时间戳
let flushTimer = null;

function getEventFile() {
  if (!EVENT_FILE) {
    EVENT_FILE = path.join(app.getPath('userData'), 'event-log.json');
  }
  return EVENT_FILE;
}

/** 本地日期 YYYY-MM-DD */
function todayKey(date) {
  const d = date ? new Date(date) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function emptyDay() {
  const day = {};
  for (const k of DAILY_KEYS) day[k] = 0;
  return day;
}

function emptyStore() {
  return { events: [], daily: {} };
}

/** 规范化从磁盘读到的数据，容错损坏内容 */
function normalizeStore(raw) {
  const s = emptyStore();
  if (!raw || typeof raw !== 'object') return s;
  if (Array.isArray(raw.events)) {
    s.events = raw.events.slice(-MAX_EVENTS);
  }
  if (raw.daily && typeof raw.daily === 'object') {
    s.daily = raw.daily;
  }
  return s;
}

function load() {
  if (store) return store;
  try {
    const file = getEventFile();
    if (fs.existsSync(file)) {
      store = normalizeStore(JSON.parse(fs.readFileSync(file, 'utf-8')));
    }
  } catch (err) {
    console.error('[EventLog] 读取事件日志失败:', err.message);
  }
  if (!store) store = emptyStore();
  return store;
}

/** 立即落盘（含清空定时器与脏计数） */
function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    fs.writeFileSync(getEventFile(), JSON.stringify(load(), null, 2), 'utf-8');
    dirtyCount = 0;
    lastFlushAt = Date.now();
  } catch (err) {
    console.error('[EventLog] 写入事件日志失败:', err.message);
  }
}

/** 标记有变更：达到阈值/间隔即落盘，否则安排一次延迟落盘 */
function markDirty() {
  dirtyCount += 1;
  const now = Date.now();
  if (dirtyCount >= FLUSH_THRESHOLD || (now - lastFlushAt) >= FLUSH_INTERVAL_MS) {
    flush();
    return;
  }
  if (!flushTimer) {
    const wait = Math.max(0, FLUSH_INTERVAL_MS - (now - lastFlushAt));
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, wait);
    if (flushTimer.unref) flushTimer.unref();
  }
}

/** 累加 daily 计数 */
function bumpDaily(s, entry) {
  if (COUNTED_TYPES.indexOf(entry.type) === -1) return;
  const pid = entry.profileId || '';
  const day = todayKey();
  if (!s.daily[pid]) s.daily[pid] = {};
  if (!s.daily[pid][day]) s.daily[pid][day] = emptyDay();
  s.daily[pid][day][entry.type] = (s.daily[pid][day][entry.type] || 0) + 1;
}

/**
 * 记录一条事件
 * @param {{profileId?:string, type:string, sub?:string, detail?:string, meta?:object}} evt
 * @returns {object|null} 记录成功返回事件对象；type 缺失返回 null
 */
function recordEvent(evt) {
  if (!evt || typeof evt !== 'object' || !evt.type) return null;
  const s = load();
  const entry = {
    ts: Date.now(),
    profileId: evt.profileId || '',
    type: String(evt.type),
    sub: evt.sub || '',
    detail: evt.detail || '',
    meta: (evt.meta && typeof evt.meta === 'object') ? evt.meta : {},
  };
  s.events.push(entry);
  if (s.events.length > MAX_EVENTS) {
    s.events.splice(0, s.events.length - MAX_EVENTS);
  }
  bumpDaily(s, entry);
  markDirty();
  return entry;
}

/**
 * 最近 N 条事件（按时间正序返回，最早在前）
 * @param {number} [limit=50]
 * @returns {object[]}
 */
function getRecentEvents(limit) {
  const s = load();
  const n = (typeof limit === 'number' && limit > 0) ? limit : 50;
  return s.events.slice(-n).map((e) => Object.assign({}, e));
}

/**
 * 某窗口某天的统计
 * @param {string} profileId
 * @param {string} [date] YYYY-MM-DD，缺省为今天
 * @returns {{nag:number, intercept:number, dispatch:number, done:number, sent:number, received:number}}
 */
function getDailyStats(profileId, date) {
  const s = load();
  const d = date || todayKey();
  const pid = profileId || '';
  const day = s.daily[pid] && s.daily[pid][d];
  return day ? Object.assign(emptyDay(), day) : emptyDay();
}

/**
 * 所有窗口某天的汇总统计
 * @param {string} [date] YYYY-MM-DD，缺省为今天
 * @returns {{nag:number, intercept:number, dispatch:number, done:number, sent:number, received:number}}
 */
function getAllDailyStats(date) {
  const s = load();
  const d = date || todayKey();
  const out = emptyDay();
  for (const pid of Object.keys(s.daily)) {
    const day = s.daily[pid][d];
    if (!day) continue;
    for (const k of DAILY_KEYS) out[k] += (day[k] || 0);
  }
  return out;
}

/** 读取会话收发计数（沿用 conversation-stats.js 的文件） */
function readConversationStats() {
  try {
    const file = path.join(app.getPath('userData'), 'conversation-stats.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error('[EventLog] 读取会话计数失败:', err.message);
  }
  return {};
}

/**
 * 今日汇总：催促/拦截/派发/完成来自事件日志，收发来自 conversation-stats
 * @returns {{nag:number, intercept:number, dispatch:number, done:number, sent:number, received:number}}
 */
function getSummary() {
  const daily = getAllDailyStats();
  const cs = readConversationStats();
  const day = todayKey();
  let sent = 0;
  let received = 0;
  for (const pid of Object.keys(cs)) {
    const d = cs[pid] && cs[pid][day];
    if (!d) continue;
    sent += d.sent || 0;
    received += d.received || 0;
  }
  return {
    nag: daily.nag,
    intercept: daily.intercept,
    dispatch: daily.dispatch,
    done: daily.done,
    sent,
    received,
  };
}

module.exports = {
  recordEvent,
  getRecentEvents,
  getDailyStats,
  getAllDailyStats,
  getSummary,
  flush,
  todayKey,
};
