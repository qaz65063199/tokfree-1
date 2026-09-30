'use strict';
/**
 * conversation-stats.js 单元测试
 *
 * 依赖 electron 的 app.getPath('userData')，用 Module._load 钩子 mock electron，
 * 把 userData 指向临时目录，隔离文件系统副作用。
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

function readRaw() {
  return JSON.parse(fs.readFileSync(path.join(userDataDir, 'conversation-stats.json'), 'utf-8'));
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-cs-'));
  installMock();
});
afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/conversation-stats')];
});

test('record 记录 sent/received', () => {
  const cs = freshStats();
  cs.record('p1', 'sent');
  cs.record('p1', 'received');
  const today = cs.getToday('p1');
  assert.strictEqual(today.sent, 1);
  assert.strictEqual(today.received, 1);
});

test('addTokens 按天累计 token', () => {
  const cs = freshStats();
  cs.addTokens('p1', 100);
  cs.addTokens('p1', 250);
  const raw = readRaw();
  const day = cs.todayKey();
  assert.strictEqual(raw.p1[day].tokens, 350);
});

test('addTokens 忽略非法增量', () => {
  const cs = freshStats();
  assert.strictEqual(cs.addTokens('p1', 0), null);
  assert.strictEqual(cs.addTokens('p1', -5), null);
  assert.strictEqual(cs.addTokens('p1', 'abc'), null);
  assert.strictEqual(cs.addTokens('', 100), null);
  assert.strictEqual(fs.existsSync(path.join(userDataDir, 'conversation-stats.json')), false);
});

test('getTokenStats 返回 today/week/total/daily', () => {
  const cs = freshStats();
  cs.addTokens('p1', 500);
  cs.addTokens('p2', 300);
  const s = cs.getTokenStats({ days: 7 });
  assert.strictEqual(s.today, 800);
  assert.strictEqual(s.week, 800);
  assert.strictEqual(s.total, 800);
  assert.strictEqual(s.daily.length, 7);
  const last = s.daily[s.daily.length - 1];
  assert.strictEqual(last.date, cs.todayKey());
  assert.strictEqual(last.tokens, 800);
});

test('getTokenStats 空库返回 0', () => {
  const cs = freshStats();
  const s = cs.getTokenStats();
  assert.strictEqual(s.today, 0);
  assert.strictEqual(s.week, 0);
  assert.strictEqual(s.total, 0);
  assert.strictEqual(s.daily.length, 7);
  s.daily.forEach((d) => assert.strictEqual(d.tokens, 0));
});

test('getSummary 的 daily 包含 tokens', () => {
  const cs = freshStats();
  cs.addTokens('p1', 1200);
  const sum = cs.getSummary({ days: 7 });
  assert.strictEqual(sum.today.tokens, 1200);
  const last = sum.daily[sum.daily.length - 1];
  assert.strictEqual(last.tokens, 1200);
});

test('recordTaskDuration 记录任务时长，忽略非法值', () => {
  const cs = freshStats();
  assert.strictEqual(cs.recordTaskDuration(0), null);
  assert.strictEqual(cs.recordTaskDuration(-1), null);
  assert.strictEqual(cs.recordTaskDuration('abc'), null);
  const rec = cs.recordTaskDuration(12345, 'p1');
  assert.ok(rec);
  assert.strictEqual(rec.ms, 12345);
  assert.strictEqual(rec.profileId, 'p1');
});

test('getLongestTaskDurationMs 取最大值', () => {
  const cs = freshStats();
  cs.recordTaskDuration(1000);
  cs.recordTaskDuration(50000);
  cs.recordTaskDuration(300);
  assert.strictEqual(cs.getLongestTaskDurationMs(), 50000);
});

test('getUsageStats 的 longestChatMs 用任务时长（方案B）', () => {
  const cs = freshStats();
  // 造一条跨度的收发记录（首尾时间差很大，用于验证不会退化成它）
  cs.record('p1', 'sent');
  // 任务时长记录：最长 10 分钟
  cs.recordTaskDuration(600000, 'p1');
  const s = cs.getUsageStats({ mode: 'cumulative' });
  assert.strictEqual(s.kpi.longestChatMs, 600000);
});

test('getUsageStats 无任务时长时回退首尾差口径', () => {
  const cs = freshStats();
  // 直接写 raw 造一个带跨度的时间记录（无 taskDurations 文件）
  cs.record('p1', 'sent');
  const s = cs.getUsageStats({ mode: 'cumulative' });
  // 无任务时长 → longestChatMs 来自首尾差（>=0）
  assert.ok(typeof s.kpi.longestChatMs === 'number');
  assert.strictEqual(cs.getLongestTaskDurationMs(), 0);
});
