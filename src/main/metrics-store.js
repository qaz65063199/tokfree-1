/**
 * 指标数据层（Metrics Store）—— 聚合用量/任务指标，为「数据看板」提供数据
 *
 * 借鉴 Mastra 的 observability/metrics 思路：把分散的 token 用量、任务成败
 * 按 天 × profile 维度聚合落盘，供后续看板 / 趋势分析读取。
 *
 * 存储：userData/metrics/<YYYY-MM>.json，按月分文件。单文件结构：
 * {
 *   "2026-09-28": {
 *     "profiles": { "<profileId>": { tokensIn, tokensOut, tasks, success, fail } },
 *     "total": { tokensIn, tokensOut }
 *   }
 * }
 *
 * 设计要点（与 event-log.js 同风格）：
 * - 模块内缓存每个月的 store（monthCache），避免重复读盘。
 * - 落盘节流：累计 20 次变更或距上次落盘 5 秒写入一次；flush() 强制落盘。
 * - 全 try/catch；损坏 JSON 容错（重置为空 + 备份损坏文件）。
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const FLUSH_INTERVAL_MS = 5000;
const FLUSH_THRESHOLD = 20;

// 计数字段全集（保持结构稳定）
const PROFILE_KEYS = ['tokensIn', 'tokensOut', 'tasks', 'success', 'fail'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let BASE_DIR = null;
const monthCache = new Map(); // 'YYYY-MM' -> store object
const dirtyMonths = new Set(); // 待落盘的月份
let dirtyCount = 0;
let lastFlushAt = 0;
let flushTimer = null;

function num(v) {
  return (typeof v === 'number' && isFinite(v)) ? v : 0;
}

/** metrics 目录（懒解析 userData） */
function getBaseDir() {
  if (!BASE_DIR) {
    BASE_DIR = path.join(app.getPath('userData'), 'metrics');
  }
  return BASE_DIR;
}

/** 本地日期 YYYY-MM-DD */
function dayKey(date) {
  const d = date ? new Date(date) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 由日期串取月份键 YYYY-MM */
function monthKey(dateStr) {
  return String(dateStr).slice(0, 7);
}

/** 解析 YYYY-MM-DD 为本地 Date（失败返回 null） */
function parseDate(str) {
  const m = DATE_RE.exec(String(str || ''));
  if (!m) return null;
  const parts = m[0].split('-');
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

/** 本周起始（周一） */
function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay(); // 0=周日
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d;
}

function emptyProfile() {
  const p = {};
  for (const k of PROFILE_KEYS) p[k] = 0;
  return p;
}

function emptyDay() {
  return { profiles: {}, total: { tokensIn: 0, tokensOut: 0 } };
}

function emptyStore() {
  return {};
}

/** 备份损坏文件（重命名为 .corrupt-<ts>），失败静默 */
function backupCorrupted(file) {
  try {
    if (file && fs.existsSync(file)) {
      fs.renameSync(file, file + '.corrupt-' + Date.now());
    }
  } catch (_) { /* ignore */ }
}

/** 规范化磁盘读到的数据，容错损坏内容 */
function normalizeStore(raw) {
  const s = emptyStore();
  if (!raw || typeof raw !== 'object') return s;
  for (const dk of Object.keys(raw)) {
    if (!DATE_RE.test(dk)) continue;
    const day = raw[dk];
    if (!day || typeof day !== 'object') continue;
    const nd = emptyDay();
    if (day.profiles && typeof day.profiles === 'object') {
      for (const pid of Object.keys(day.profiles)) {
        const p = day.profiles[pid];
        if (!p || typeof p !== 'object') continue;
        const np = emptyProfile();
        for (const k of PROFILE_KEYS) np[k] = num(p[k]);
        nd.profiles[pid] = np;
      }
    }
    if (day.total && typeof day.total === 'object') {
      nd.total = { tokensIn: num(day.total.tokensIn), tokensOut: num(day.total.tokensOut) };
    }
    s[dk] = nd;
  }
  return s;
}

function monthFile(mk) {
  return path.join(getBaseDir(), mk + '.json');
}

/** 载入某月的 store（模块内缓存；损坏则备份并重置为空） */
function loadMonth(mk) {
  if (monthCache.has(mk)) return monthCache.get(mk);
  let store = emptyStore();
  const file = monthFile(mk);
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8');
      store = normalizeStore(JSON.parse(raw));
    }
  } catch (err) {
    console.error('[MetricsStore] 读取指标文件失败:', err.message);
    backupCorrupted(file);
    store = emptyStore();
  }
  monthCache.set(mk, store);
  return store;
}

/** 写入某月文件（自动建目录） */
function persistMonth(mk) {
  try {
    const dir = getBaseDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const store = monthCache.get(mk) || emptyStore();
    fs.writeFileSync(monthFile(mk), JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.error('[MetricsStore] 写入指标文件失败:', err.message);
  }
}

/** 立即落盘所有脏月份（含清空定时器与脏计数） */
function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    for (const mk of dirtyMonths) persistMonth(mk);
    dirtyMonths.clear();
    dirtyCount = 0;
    lastFlushAt = Date.now();
  } catch (err) {
    console.error('[MetricsStore] 落盘失败:', err.message);
  }
}

/** 标记某月有变更：达到阈值/间隔即落盘，否则安排一次延迟落盘 */
function markDirty(mk) {
  if (mk) dirtyMonths.add(mk);
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

/**
 * 记录指标：把 delta 累加到「今天」的该 profile。
 * @param {string} profileId
 * @param {{tokensIn?:number, tokensOut?:number, tasks?:number, success?:number, fail?:number}} delta
 * @returns {object|null} 累加后的 profile 数据；失败返回 null
 */
function record(profileId, delta) {
  try {
    const pid = profileId || '';
    const dk = dayKey();
    const mk = monthKey(dk);
    const store = loadMonth(mk);
    if (!store[dk]) store[dk] = emptyDay();
    const day = store[dk];
    if (!day.profiles) day.profiles = {};
    if (!day.profiles[pid]) day.profiles[pid] = emptyProfile();
    if (!day.total) day.total = { tokensIn: 0, tokensOut: 0 };
    const p = day.profiles[pid];
    const dd = (delta && typeof delta === 'object') ? delta : {};
    for (const k of PROFILE_KEYS) {
      p[k] = num(p[k]) + num(dd[k]);
    }
    day.total.tokensIn = num(day.total.tokensIn) + num(dd.tokensIn);
    day.total.tokensOut = num(day.total.tokensOut) + num(dd.tokensOut);
    markDirty(mk);
    return Object.assign({}, p);
  } catch (err) {
    console.error('[MetricsStore] 记录指标失败:', err.message);
    return null;
  }
}

/**
 * 某天某 profile 的数据。
 * @param {string} profileId
 * @param {string} [dateStr] YYYY-MM-DD，缺省今天
 * @returns {{tokensIn:number, tokensOut:number, tasks:number, success:number, fail:number}}
 */
function getDaily(profileId, dateStr) {
  try {
    const dk = dateStr || dayKey();
    const mk = monthKey(dk);
    const store = loadMonth(mk);
    const day = store[dk];
    if (!day) return emptyProfile();
    const pid = profileId || '';
    return Object.assign(emptyProfile(), (day.profiles && day.profiles[pid]) || {});
  } catch (err) {
    console.error('[MetricsStore] 读取日指标失败:', err.message);
    return emptyProfile();
  }
}

/** 读取某天数据并做 profile 维度聚合（pid 为空则汇总所有 profile） */
function readDayAgg(dk, pid) {
  const store = loadMonth(monthKey(dk));
  const day = store[dk];
  const agg = emptyProfile();
  if (!day || !day.profiles) return agg;
  if (pid) {
    return Object.assign(agg, day.profiles[pid] || {});
  }
  for (const key of Object.keys(day.profiles)) {
    const p = day.profiles[key] || {};
    for (const k of PROFILE_KEYS) agg[k] += num(p[k]);
  }
  return agg;
}

/**
 * 日期区间内每天的指标。
 * @param {string} profileId 传空则汇总所有 profile
 * @param {string} fromDate YYYY-MM-DD
 * @param {string} toDate YYYY-MM-DD
 * @returns {Array<{date:string, tokensIn:number, tokensOut:number, tasks:number, success:number, fail:number}>}
 */
function getRange(profileId, fromDate, toDate) {
  const out = [];
  try {
    const from = parseDate(fromDate);
    const to = parseDate(toDate);
    if (!from || !to || from > to) return out;
    const pid = profileId || null;
    const cur = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    while (cur <= to) {
      const dk = dayKey(cur);
      out.push(Object.assign({ date: dk }, readDayAgg(dk, pid)));
      cur.setDate(cur.getDate() + 1);
    }
  } catch (err) {
    console.error('[MetricsStore] 读取区间指标失败:', err.message);
  }
  return out;
}

/** 聚合区间数组为单条总计 */
function aggregateRange(arr) {
  const agg = emptyProfile();
  for (const it of arr) {
    for (const k of PROFILE_KEYS) agg[k] += num(it[k]);
  }
  return agg;
}

/**
 * 汇总：今日 / 本周（周一起）/ 本月。
 * @param {string} profileId 传空则汇总所有 profile
 * @returns {{today:object, week:object, month:object}}
 */
function getSummary(profileId) {
  try {
    const now = new Date();
    const today = dayKey(now);
    const weekStart = dayKey(startOfWeek(now));
    const monthStart = dayKey(new Date(now.getFullYear(), now.getMonth(), 1));
    const pid = profileId || null;
    return {
      today: readDayAgg(today, pid),
      week: aggregateRange(getRange(profileId, weekStart, today)),
      month: aggregateRange(getRange(profileId, monthStart, today)),
    };
  } catch (err) {
    console.error('[MetricsStore] 汇总指标失败:', err.message);
    return { today: emptyProfile(), week: emptyProfile(), month: emptyProfile() };
  }
}

/** 清空内存缓存（测试用） */
function _reset() {
  monthCache.clear();
  dirtyMonths.clear();
  dirtyCount = 0;
  lastFlushAt = 0;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  BASE_DIR = null;
}

module.exports = {
  record,
  getDaily,
  getRange,
  getSummary,
  flush,
  dayKey,
  monthKey,
  _reset,
};
