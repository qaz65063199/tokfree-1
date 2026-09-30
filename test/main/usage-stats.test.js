'use strict';
/**
 * conversation-stats.getUsageStats 单元测试
 *
 * 与 conversation-stats.test.js 相同的 electron mock 策略：把 userData 指向临时目录。
 * getUsageStats 会 require('./profile-manager') 取窗口名称，故同时写入 profile-list.json。
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const origLoad = Module._load;
let userDataDir;

function installMock() {
  Module._load = function (request) {
    if (request === 'electron') {
      return { app: { getPath: () => userDataDir, setPath: () => {} } };
    }
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() { Module._load = origLoad; }

function freshStats() {
  delete require.cache[require.resolve('../../src/main/conversation-stats')];
  return require('../../src/main/conversation-stats');
}

function clearProfileManagerCache() {
  try { delete require.cache[require.resolve('../../src/main/profile-manager')]; } catch (_) {}
}

function writeStats(obj) {
  fs.writeFileSync(path.join(userDataDir, 'conversation-stats.json'), JSON.stringify(obj), 'utf-8');
}

function writeProfiles(list) {
  fs.writeFileSync(path.join(userDataDir, 'profile-list.json'), JSON.stringify(list), 'utf-8');
}

/** 相对今天偏移 offset 天的日期键 */
function dayKey(offset) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-usage-'));
  installMock();
  clearProfileManagerCache();
});
afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/conversation-stats')];
  clearProfileManagerCache();
});

test('无数据时返回零值/空数组且不抛错', () => {
  const cs = freshStats();
  const r = cs.getUsageStats({ mode: 'daily', rangeDays: 7 });
  assert.strictEqual(r.kpi.totalTokens, 0);
  assert.strictEqual(r.kpi.peakTokens, 0);
  assert.strictEqual(r.kpi.longestChatMs, 0);
  assert.strictEqual(r.kpi.currentStreak, 0);
  assert.strictEqual(r.kpi.longestStreak, 0);
  assert.deepStrictEqual(r.trend.length, 7);
  assert.strictEqual(r.byWindow.length, 0);
});

test('kpi: totalTokens / peakTokens / longestChatMs', () => {
  writeStats({
    p1: {
      [dayKey(1)]: { tokens: 100, firstAt: 1000, lastAt: 6000 },
      [dayKey(0)]: { tokens: 50, firstAt: 2000, lastAt: 3000 },
    },
    p2: {
      [dayKey(0)]: { tokens: 70 },
    },
  });
  const cs = freshStats();
  const r = cs.getUsageStats();
  // total = 100 + 50 + 70
  assert.strictEqual(r.kpi.totalTokens, 220);
  // peak：今天 50+70=120 > 昨天 100
  assert.strictEqual(r.kpi.peakTokens, 120);
  // longestChatMs：max(5000, 1000) = 5000
  assert.strictEqual(r.kpi.longestChatMs, 5000);
});

test('streak: 连续天数（今天连昨天）', () => {
  writeStats({
    p1: {
      [dayKey(0)]: { tokens: 10 },
      [dayKey(1)]: { tokens: 10 },
      [dayKey(2)]: { tokens: 10 },
      [dayKey(5)]: { tokens: 10 },
    },
  });
  const cs = freshStats();
  const r = cs.getUsageStats();
  assert.strictEqual(r.kpi.currentStreak, 3); // 今天/昨天/前天
  assert.strictEqual(r.kpi.longestStreak, 3);
});

test('streak: 今天无活动则 currentStreak=0，longestStreak 仍计算', () => {
  writeStats({
    p1: {
      [dayKey(2)]: { tokens: 10 },
      [dayKey(3)]: { tokens: 10 },
    },
  });
  const cs = freshStats();
  const r = cs.getUsageStats();
  assert.strictEqual(r.kpi.currentStreak, 0);
  assert.strictEqual(r.kpi.longestStreak, 2);
});

test('trend: 近 rangeDays 天含合计', () => {
  writeStats({
    p1: { [dayKey(0)]: { tokens: 33 }, [dayKey(1)]: { tokens: 22 } },
    p2: { [dayKey(1)]: { tokens: 11 } },
  });
  const cs = freshStats();
  const r = cs.getUsageStats({ rangeDays: 3 });
  assert.strictEqual(r.trend.length, 3);
  assert.strictEqual(r.trend[2].date, dayKey(0));
  assert.strictEqual(r.trend[2].tokens, 33);
  assert.strictEqual(r.trend[1].tokens, 33); // 22 + 11
});

test('activity(daily) + byWindow 名称与占比', () => {
  writeProfiles([
    { id: 'p1', name: '窗口甲' },
    { id: 'p2', name: '窗口乙' },
  ]);
  writeStats({
    p1: { [dayKey(0)]: { tokens: 75 } },
    p2: { [dayKey(0)]: { tokens: 25 } },
  });
  const cs = freshStats();
  const r = cs.getUsageStats({ mode: 'daily', rangeDays: 2 });
  assert.strictEqual(r.activity.length, 2);
  assert.strictEqual(r.activity[1].label, dayKey(0));
  assert.strictEqual(r.activity[1].tokens, 100);
  assert.strictEqual(r.byWindow.length, 2);
  assert.strictEqual(r.byWindow[0].name, '窗口甲');
  assert.strictEqual(r.byWindow[0].tokens, 75);
  assert.strictEqual(r.byWindow[0].pct, 75);
  assert.strictEqual(r.byWindow[1].pct, 25);
});

test('byWindow: 取不到 profile 名则用 id 前 8 位', () => {
  writeProfiles([]);
  writeStats({ 'profile-abcdef123456': { [dayKey(0)]: { tokens: 5 } } });
  const cs = freshStats();
  const r = cs.getUsageStats({ mode: 'daily', rangeDays: 1 });
  assert.strictEqual(r.byWindow[0].name, 'profile-');
});

test('activity(weekly) 与 (cumulative) 返回 label 数组', () => {
  writeStats({ p1: { [dayKey(0)]: { tokens: 9 } } });
  const cs = freshStats();
  const w = cs.getUsageStats({ mode: 'weekly', rangeDays: 3 });
  assert.strictEqual(w.activity.length, 3);
  const c = cs.getUsageStats({ mode: 'cumulative', rangeDays: 3 });
  assert.strictEqual(c.activity.length, 3);
  assert.ok(c.activity[2].tokens >= 9);
});
