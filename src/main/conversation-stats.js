/**
 * 会话收发计数（每 profile + 每天）
 * 存储于 userData/conversation-stats.json，结构：
 * { [profileId]: { 'YYYY-MM-DD': { sent, received, tokens?, firstAt?, lastAt? } } }
 *
 * 兼容性：sent/received 为原有字段，保持不变；tokens / firstAt / lastAt 为新增可选字段。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

let STATS_FILE = null;

// 持久化上限：避免文件无限增长
const MAX_DAYS_PER_PROFILE = 120; // 每窗口最多保留最近 120 天
const MAX_PROFILES = 60;          // 最多保留 60 个窗口的统计

function getStatsFile() {
  if (!STATS_FILE) {
    STATS_FILE = path.join(app.getPath('userData'), 'conversation-stats.json');
  }
  return STATS_FILE;
}

// ===== 任务计时（方案B）：记录"一次任务实际执行时长"，与按天收发计数分开存 =====
// 存储于 userData/task-durations.json，结构：[{ ms, at, profileId }]
const MAX_TASK_DURS = 200;
function getTaskDurFile() {
  try { return path.join(app.getPath('userData'), 'task-durations.json'); } catch (_) { return null; }
}
function readTaskDurs() {
  try {
    const f = getTaskDurFile();
    if (f && fs.existsSync(f)) {
      const o = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (Array.isArray(o)) return o;
      if (o && Array.isArray(o.durations)) return o.durations;
    }
  } catch (err) {
    console.error('[Stats] 读取任务时长失败:', err.message);
  }
  return [];
}
/**
 * 记录一次任务的实际执行时长（任务结束/胶囊计时冻结时上报）
 * @param {number} durationMs 时长（毫秒，>0 有效）
 * @param {string} [profileId] 所属窗口
 * @returns {object|null} 写入的记录
 */
function recordTaskDuration(durationMs, profileId) {
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  try {
    const f = getTaskDurFile();
    if (!f) return null;
    const arr = readTaskDurs();
    const rec = { ms: Math.round(ms), at: Date.now(), profileId: profileId || '' };
    arr.push(rec);
    while (arr.length > MAX_TASK_DURS) arr.shift();
    fs.writeFileSync(f, JSON.stringify(arr, null, 2), 'utf-8');
    return rec;
  } catch (err) {
    console.error('[Stats] 记录任务时长失败:', err.message);
    return null;
  }
}
/** 取历史最长任务时长（毫秒）；无记录返回 0 */
function getLongestTaskDurationMs() {
  let max = 0;
  for (const d of readTaskDurs()) {
    if (d && Number(d.ms) > max) max = Number(d.ms);
  }
  return max;
}

function readStats() {
  try {
    const file = getStatsFile();
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch (err) {
    console.error('[Stats] 读取会话计数失败:', err.message);
  }
  return {};
}

function writeStats(stats) {
  try {
    fs.writeFileSync(getStatsFile(), JSON.stringify(stats, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Stats] 写入会话计数失败:', err.message);
  }
}

/** 本地日期 YYYY-MM-DD */
function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 相对今天偏移 offset 天的日期键（offset=0 即今天） */
function dayKeyOffset(offset) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 返回最近 n 天（含今天）的日期键数组，按时间升序 */
function lastNDays(n) {
  const arr = [];
  const count = Math.max(1, Number(n) || 1);
  for (let i = count - 1; i >= 0; i--) arr.push(dayKeyOffset(i));
  return arr;
}

/** 单窗口的某天记录最大时间戳（用于窗口淘汰排序） */
function profileLastAt(profileStats) {
  let m = 0;
  for (const k of Object.keys(profileStats || {})) {
    const d = profileStats[k];
    if (d && d.lastAt > m) m = d.lastAt;
  }
  return m;
}

/** 裁剪单窗口的天数，仅保留最近 MAX_DAYS_PER_PROFILE 天 */
function pruneProfile(profileStats) {
  const keys = Object.keys(profileStats);
  if (keys.length <= MAX_DAYS_PER_PROFILE) return;
  keys.sort();
  const drop = keys.slice(0, keys.length - MAX_DAYS_PER_PROFILE);
  for (const k of drop) delete profileStats[k];
}

/** 裁剪窗口数量，仅保留最近有活动的 MAX_PROFILES 个窗口 */
function pruneProfiles(stats) {
  const ids = Object.keys(stats);
  if (ids.length <= MAX_PROFILES) return;
  ids.sort((a, b) => profileLastAt(stats[b]) - profileLastAt(stats[a]));
  const drop = ids.slice(MAX_PROFILES);
  for (const id of drop) delete stats[id];
}

/**
 * 记录一次收发
 * @param {string} profileId
 * @param {'sent'|'received'} type
 * @param {{tokens?:number}} [extra] 可选：附带 token 数（若可得）
 * @returns {object|null} 当天的计数对象
 */
function record(profileId, type, extra) {
  if (!profileId) return null;
  const stats = readStats();
  if (!stats[profileId]) stats[profileId] = {};
  const day = todayKey();
  if (!stats[profileId][day]) stats[profileId][day] = { sent: 0, received: 0 };
  const rec = stats[profileId][day];
  if (type === 'received') rec.received += 1;
  else rec.sent += 1;
  // token（可选，若调用方提供）
  const tokens = extra && Number(extra.tokens);
  if (tokens > 0) rec.tokens = (rec.tokens || 0) + tokens;
  // 活跃时间戳（用于估算活跃时长）
  const now = Date.now();
  if (!rec.firstAt) rec.firstAt = now;
  rec.lastAt = now;

  pruneProfile(stats[profileId]);
  pruneProfiles(stats);
  writeStats(stats);
  return rec;
}

/** 获取某 profile 今日计数（兼容旧接口） */
function getToday(profileId) {
  const stats = readStats();
  const day = todayKey();
  return (stats[profileId] && stats[profileId][day]) || { sent: 0, received: 0 };
}

/** 把某窗口指定日期键集合聚合为总量 */
function aggregateDays(profileStats, keys) {
  const acc = { sent: 0, received: 0, tokens: 0, activeMs: 0 };
  if (!profileStats) return acc;
  for (const k of keys) {
    const d = profileStats[k];
    if (!d) continue;
    acc.sent += d.sent || 0;
    acc.received += d.received || 0;
    acc.tokens += d.tokens || 0;
    if (d.firstAt && d.lastAt && d.lastAt > d.firstAt) {
      acc.activeMs += (d.lastAt - d.firstAt);
    }
  }
  return acc;
}

/** 就地累加聚合值 */
function addInto(target, src) {
  target.sent += src.sent || 0;
  target.received += src.received || 0;
  target.tokens += src.tokens || 0;
  target.activeMs += src.activeMs || 0;
  return target;
}

/**
 * 汇总统计
 * @param {{days?:number}} [opts] days：daily 序列包含的天数（默认 7）
 * @returns {{today:object, week:object, byWindow:Array, daily:Array}}
 */
function getSummary(opts) {
  const stats = readStats();
  const days = Math.max(1, Number(opts && opts.days) || 7);

  const todayKeys = [todayKey()];
  const weekKeys = lastNDays(7);
  const rangeKeys = lastNDays(days);

  const profileIds = Object.keys(stats);

  const todayTotal = { sent: 0, received: 0, tokens: 0, activeMs: 0 };
  const weekTotal = { sent: 0, received: 0, tokens: 0, activeMs: 0 };
  const byWindow = [];

  for (const profileId of profileIds) {
    const ps = stats[profileId] || {};
    const t = aggregateDays(ps, todayKeys);
    const w = aggregateDays(ps, weekKeys);
    addInto(todayTotal, t);
    addInto(weekTotal, w);
    byWindow.push({
      profileId,
      today: t,
      week: w,
      lastAt: profileLastAt(ps),
    });
  }

  // 按最近活动时间倒序排列窗口
  byWindow.sort((a, b) => b.lastAt - a.lastAt);

  // 每日序列（全部窗口合计）
  const daily = rangeKeys.map((date) => {
    const agg = { date, sent: 0, received: 0, tokens: 0, activeMs: 0 };
    for (const profileId of profileIds) {
      const d = stats[profileId][date];
      if (!d) continue;
      agg.sent += d.sent || 0;
      agg.received += d.received || 0;
      agg.tokens += d.tokens || 0;
      if (d.firstAt && d.lastAt && d.lastAt > d.firstAt) {
        agg.activeMs += (d.lastAt - d.firstAt);
      }
    }
    return agg;
  });

  return { today: todayTotal, week: weekTotal, byWindow, daily };
}

/**
 * 累加 token 增量到指定 profile 的今天（按天累计）
 * @param {string} profileId
 * @param {number} delta 增量（正数）
 * @returns {object|null} 当天的记录
 */
function addTokens(profileId, delta) {
  if (!profileId) return null;
  const n = Number(delta);
  if (!Number.isFinite(n) || n <= 0) return null;
  const stats = readStats();
  if (!stats[profileId]) stats[profileId] = {};
  const day = todayKey();
  if (!stats[profileId][day]) stats[profileId][day] = { sent: 0, received: 0 };
  const rec = stats[profileId][day];
  rec.tokens = (rec.tokens || 0) + n;
  const now = Date.now();
  if (!rec.firstAt) rec.firstAt = now;
  rec.lastAt = now;

  pruneProfile(stats[profileId]);
  pruneProfiles(stats);
  writeStats(stats);
  return rec;
}

/**
 * Token 专用统计（今日 / 本周 / 总计 + 每日序列）
 * @param {{days?:number}} [opts] days：daily 序列包含的天数（默认 7）
 * @returns {{today:number, week:number, total:number, daily:Array<{date:string,tokens:number}>}}
 */
function getTokenStats(opts) {
  const stats = readStats();
  const days = Math.max(1, Number(opts && opts.days) || 7);

  const todayKeys = [todayKey()];
  const weekKeys = lastNDays(7);
  const rangeKeys = lastNDays(days);

  const profileIds = Object.keys(stats);

  let today = 0;
  let week = 0;
  let total = 0;

  for (const profileId of profileIds) {
    const ps = stats[profileId] || {};
    today += aggregateDays(ps, todayKeys).tokens;
    week += aggregateDays(ps, weekKeys).tokens;
    for (const k of Object.keys(ps)) {
      const d = ps[k];
      if (d && d.tokens) total += d.tokens;
    }
  }

  const daily = rangeKeys.map((date) => {
    let tokens = 0;
    for (const profileId of profileIds) {
      const d = stats[profileId][date];
      if (d) tokens += d.tokens || 0;
    }
    return { date, tokens };
  });

  return { today, week, total, daily };
}


/** 把日期键转为 UTC 天序号（用于判断连续天） */
function dayIndexOfKey(key) {
  const parts = String(key).split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86400000);
}

/** 格式化本地日期为 YYYY-MM-DD */
function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 相对本周（周一起）偏移 offset 周的周一日期键 */
function weekStartKeyOffset(offset) {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - dow - (Number(offset) || 0) * 7);
  return fmtDate(d);
}

/** 相对本月偏移 offset 月的 YYYY-MM 键 */
function monthKeyOffset(offset) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - (Number(offset) || 0));
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1);
}

/** 汇总指定日期键集合在全部 profile 下的 token 总量 */
function sumTokensForKeys(stats, profileIds, keys) {
  let tokens = 0;
  for (const pid of profileIds) {
    const ps = stats[pid];
    if (!ps) continue;
    for (const k of keys) {
      const d = ps[k];
      if (d && d.tokens) tokens += d.tokens;
    }
  }
  return tokens;
}

/** 构造某月（YYYY-MM）内的所有日期键 */
function monthDayKeys(ym) {
  const parts = String(ym).split('-').map(Number);
  if (parts.length !== 2 || !parts[0] || !parts[1]) return [];
  const year = parts[0];
  const month = parts[1];
  const last = new Date(year, month, 0).getDate();
  const keys = [];
  const p = (n) => String(n).padStart(2, '0');
  for (let day = 1; day <= last; day++) keys.push(year + '-' + p(month) + '-' + p(day));
  return keys;
}

/**
 * ZCode 风格使用统计：KPI + 活动（热力图）+ 趋势（折线）+ 按窗口（饼图）
 * @param {{mode?:'daily'|'weekly'|'cumulative', rangeDays?:number}} [opts]
 * @returns {{kpi:object, activity:Array, trend:Array, byWindow:Array}}
 */
function getUsageStats(opts) {
  const empty = {
    kpi: { totalTokens: 0, peakTokens: 0, longestChatMs: 0, currentStreak: 0, longestStreak: 0 },
    activity: [],
    trend: [],
    byWindow: [],
  };
  try {
    const o = opts || {};
    const mode = (o.mode === 'daily' || o.mode === 'weekly' || o.mode === 'cumulative') ? o.mode : 'cumulative';
    const rd = Number(o.rangeDays);
    const trendDays = Math.max(1, Number.isFinite(rd) && rd > 0 ? rd : 7);

    const stats = readStats();
    const profileIds = Object.keys(stats);

    // ---------- KPI ----------
    let totalTokens = 0;
    // 按日期聚合的全窗口 token 总量
    const dateTotals = {};
    // 最长任务时长（方案B）：优先用任务实际执行时长（recordTaskDuration 记录的最长一次）；
    // 无任务时长记录时，回退旧的"单日首尾时间差"口径。
    let longestChatMs = getLongestTaskDurationMs();
    const hasTaskDur = longestChatMs > 0;
    const activeDayIdx = new Set();

    for (const pid of profileIds) {
      const ps = stats[pid] || {};
      for (const key of Object.keys(ps)) {
        const d = ps[key];
        if (!d) continue;
        const tk = d.tokens || 0;
        if (tk > 0) {
          totalTokens += tk;
          dateTotals[key] = (dateTotals[key] || 0) + tk;
          const di = dayIndexOfKey(key);
          if (di !== null) activeDayIdx.add(di);
        }
        if (!hasTaskDur && d.firstAt && d.lastAt && d.lastAt > d.firstAt) {
          const ms = d.lastAt - d.firstAt;
          if (ms > longestChatMs) longestChatMs = ms;
        }
      }
    }

    let peakTokens = 0;
    for (const k of Object.keys(dateTotals)) {
      if (dateTotals[k] > peakTokens) peakTokens = dateTotals[k];
    }

    // 连续天数
    const idxs = Array.from(activeDayIdx).sort((a, b) => a - b);
    let longestStreak = 0;
    let run = 0;
    let prev = null;
    for (const x of idxs) {
      if (prev !== null && x === prev + 1) run += 1;
      else run = 1;
      if (run > longestStreak) longestStreak = run;
      prev = x;
    }
    let currentStreak = 0;
    if (idxs.length) {
      const todayIdx = dayIndexOfKey(todayKey());
      let i = todayIdx;
      while (activeDayIdx.has(i)) {
        currentStreak += 1;
        i -= 1;
      }
    }

    // ---------- activity（热力图，按 mode）----------
    const activity = [];
    const activityKeys = []; // 用于 byWindow 聚合的日期键并集
    if (mode === 'daily') {
      const n = Math.max(1, Number.isFinite(rd) && rd > 0 ? rd : 30);
      for (const date of lastNDays(n)) {
        const tokens = sumTokensForKeys(stats, profileIds, [date]);
        activity.push({ label: date, tokens });
        activityKeys.push(date);
      }
    } else if (mode === 'weekly') {
      const n = Math.max(1, Number.isFinite(rd) && rd > 0 ? rd : 12);
      for (let i = n - 1; i >= 0; i--) {
        const start = weekStartKeyOffset(i);
        const keys = lastNDaysFrom(start, 7);
        const tokens = sumTokensForKeys(stats, profileIds, keys);
        activity.push({ label: start, tokens });
        for (const k of keys) activityKeys.push(k);
      }
    } else {
      const n = Math.max(1, Number.isFinite(rd) && rd > 0 ? rd : 12);
      for (let i = n - 1; i >= 0; i--) {
        const ym = monthKeyOffset(i);
        const keys = monthDayKeys(ym);
        const tokens = sumTokensForKeys(stats, profileIds, keys);
        activity.push({ label: ym, tokens });
        for (const k of keys) activityKeys.push(k);
      }
    }

    // ---------- trend（折线：近 trendDays 天）----------
    const trend = [];
    for (const date of lastNDays(trendDays)) {
      trend.push({ date, tokens: sumTokensForKeys(stats, profileIds, [date]) });
    }

    // ---------- byWindow（饼图）----------
    let byWindow = [];
    try {
      const profileManager = require('./profile-manager');
      let sum = 0;
      const raw = [];
      for (const pid of profileIds) {
        const tokens = sumTokensForKeys(stats, [pid], activityKeys);
        if (tokens <= 0) continue;
        raw.push({ profileId: pid, tokens });
        sum += tokens;
      }
      raw.sort((a, b) => b.tokens - a.tokens);
      byWindow = raw.map((r) => {
        let name = '';
        try {
          const p = profileManager.getProfileById(r.profileId);
          name = p && p.name ? p.name : '';
        } catch (_) { name = ''; }
        if (!name) name = String(r.profileId).slice(0, 8);
        const pct = sum > 0 ? Math.round((r.tokens / sum) * 10000) / 100 : 0;
        return { profileId: r.profileId, name, tokens: r.tokens, pct };
      });
    } catch (_) {
      byWindow = [];
    }

    return {
      kpi: { totalTokens, peakTokens, longestChatMs, currentStreak, longestStreak },
      activity,
      trend,
      byWindow,
    };
  } catch (err) {
    console.error('[Stats] getUsageStats 失败:', err.message);
    return empty;
  }
}

/** 从指定起始日期键起连续 n 天（含起始日） */
function lastNDaysFrom(startKey, n) {
  const parts = String(startKey).split('-').map(Number);
  const base = new Date(parts[0], parts[1] - 1, parts[2]);
  const out = [];
  const count = Math.max(1, Number(n) || 1);
  for (let i = 0; i < count; i++) {
    const d = new Date(base.getTime());
    d.setDate(base.getDate() + i);
    out.push(fmtDate(d));
  }
  return out;
}

module.exports = {
  record,
  addTokens,
  getToday,
  todayKey,
  getSummary,
  getTokenStats,
  getUsageStats,
  recordTaskDuration,
  getLongestTaskDurationMs,
  lastNDays,
  aggregateDays,
};
