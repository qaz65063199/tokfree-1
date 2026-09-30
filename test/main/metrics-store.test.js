'use strict';
/**
 * metrics-store.js 单元测试
 *
 * metrics-store.js 依赖 electron 的 app.getPath('userData') 定位存储文件。
 * 参照 test/main/event-log.test.js 的做法，用 Module._load 钩子 mock electron，
 * 把 userData 指向临时目录，隔离文件系统副作用。
 *
 * 模块内对每月 store 有缓存，每个测试需 freshMetrics() 清除 require 缓存后重新 require；
 * 并用 flush() 强制立即落盘以便断言文件内容。
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
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath: (name) => (name === 'userData' ? userDataDir : userDataDir),
          setPath: () => {},
        },
      };
    }
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() {
  Module._load = origLoad;
}

function freshMetrics() {
  delete require.cache[require.resolve('../../src/main/metrics-store')];
  return require('../../src/main/metrics-store');
}

function metricsDir() {
  return path.join(userDataDir, 'metrics');
}

function monthFile(mk) {
  return path.join(metricsDir(), mk + '.json');
}

function readMonth(mk) {
  return JSON.parse(fs.readFileSync(monthFile(mk), 'utf-8'));
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-metrics-'));
  installMock();
});

afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/metrics-store')];
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
});

// ========== 1. 读写往返 ==========

test('record 累加到当天，getDaily 可读回', () => {
  const m = freshMetrics();
  m.record('p1', { tokensIn: 100, tokensOut: 50, tasks: 2, success: 1, fail: 1 });
  const d = m.getDaily('p1');
  assert.strictEqual(d.tokensIn, 100);
  assert.strictEqual(d.tokensOut, 50);
  assert.strictEqual(d.tasks, 2);
  assert.strictEqual(d.success, 1);
  assert.strictEqual(d.fail, 1);
});

test('record 多次调用会累加', () => {
  const m = freshMetrics();
  m.record('p1', { tokensIn: 10, tasks: 1 });
  m.record('p1', { tokensIn: 5, tokensOut: 3, success: 1 });
  const d = m.getDaily('p1');
  assert.strictEqual(d.tokensIn, 15);
  assert.strictEqual(d.tokensOut, 3);
  assert.strictEqual(d.tasks, 1);
  assert.strictEqual(d.success, 1);
});

test('record 非法/缺失 delta 安全累加', () => {
  const m = freshMetrics();
  m.record('p1'); // 无 delta
  m.record('p1', { tokensIn: 'oops', tasks: NaN, success: -1 });
  const d = m.getDaily('p1');
  assert.strictEqual(d.tokensIn, 0);
  assert.strictEqual(d.tasks, 0);
  assert.strictEqual(d.success, -1); // 负数视为有效数字，原样累加
});

test('getDaily 未知 profile / 日期返回空数据', () => {
  const m = freshMetrics();
  m.record('p1', { tokensIn: 1 });
  const unknown = m.getDaily('p999');
  assert.strictEqual(unknown.tokensIn, 0);
  const other = m.getDaily('p1', '2000-01-01');
  assert.strictEqual(other.tokensIn, 0);
});

// ========== 2. 区间 ==========

test('getRange 返回区间内每天的数组', () => {
  const m = freshMetrics();
  // 手动写一个月文件，覆盖 3 天
  fs.mkdirSync(metricsDir(), { recursive: true });
  fs.writeFileSync(monthFile('2026-08'), JSON.stringify({
    '2026-08-10': { profiles: { p1: { tokensIn: 10, tokensOut: 1, tasks: 1, success: 1, fail: 0 } }, total: { tokensIn: 10, tokensOut: 1 } },
    '2026-08-11': { profiles: { p1: { tokensIn: 20, tokensOut: 2, tasks: 2, success: 1, fail: 1 } }, total: { tokensIn: 20, tokensOut: 2 } },
    '2026-08-12': { profiles: { p1: { tokensIn: 30, tokensOut: 3, tasks: 3, success: 2, fail: 1 } }, total: { tokensIn: 30, tokensOut: 3 } },
  }), 'utf-8');
  const range = m.getRange('p1', '2026-08-10', '2026-08-12');
  assert.strictEqual(range.length, 3);
  assert.strictEqual(range[0].date, '2026-08-10');
  assert.strictEqual(range[0].tokensIn, 10);
  assert.strictEqual(range[2].date, '2026-08-12');
  assert.strictEqual(range[2].tasks, 3);
});

test('getRange 跨月边界读取两个月的文件', () => {
  const m = freshMetrics();
  fs.mkdirSync(metricsDir(), { recursive: true });
  fs.writeFileSync(monthFile('2026-08'), JSON.stringify({
    '2026-08-31': { profiles: { p1: { tokensIn: 5, tokensOut: 0, tasks: 1, success: 1, fail: 0 } }, total: { tokensIn: 5, tokensOut: 0 } },
  }), 'utf-8');
  fs.writeFileSync(monthFile('2026-09'), JSON.stringify({
    '2026-09-01': { profiles: { p1: { tokensIn: 7, tokensOut: 1, tasks: 1, success: 0, fail: 1 } }, total: { tokensIn: 7, tokensOut: 1 } },
  }), 'utf-8');
  const range = m.getRange('p1', '2026-08-31', '2026-09-01');
  assert.strictEqual(range.length, 2);
  assert.strictEqual(range[0].date, '2026-08-31');
  assert.strictEqual(range[0].tokensIn, 5);
  assert.strictEqual(range[1].date, '2026-09-01');
  assert.strictEqual(range[1].tokensIn, 7);
  assert.strictEqual(range[1].fail, 1);
});

test('getRange 无 profile 时汇总所有 profile', () => {
  const m = freshMetrics();
  fs.mkdirSync(metricsDir(), { recursive: true });
  fs.writeFileSync(monthFile('2026-08'), JSON.stringify({
    '2026-08-10': {
      profiles: {
        p1: { tokensIn: 10, tokensOut: 1, tasks: 1, success: 1, fail: 0 },
        p2: { tokensIn: 20, tokensOut: 2, tasks: 2, success: 0, fail: 2 },
      },
      total: { tokensIn: 30, tokensOut: 3 },
    },
  }), 'utf-8');
  const range = m.getRange(null, '2026-08-10', '2026-08-10');
  assert.strictEqual(range.length, 1);
  assert.strictEqual(range[0].tokensIn, 30);
  assert.strictEqual(range[0].tasks, 3);
  assert.strictEqual(range[0].fail, 2);
});

// ========== 3. 汇总 ==========

test('getSummary 返回今日/本周/本月汇总', () => {
  const m = freshMetrics();
  m.record('p1', { tokensIn: 100, tokensOut: 40, tasks: 3, success: 2, fail: 1 });
  const s = m.getSummary('p1');
  assert.strictEqual(s.today.tokensIn, 100);
  assert.strictEqual(s.today.success, 2);
  // 本周/本月至少包含今天的数据
  assert.ok(s.week.tokensIn >= 100);
  assert.ok(s.month.tokensIn >= 100);
  assert.strictEqual(typeof s.week.tasks, 'number');
  assert.strictEqual(typeof s.month.fail, 'number');
});

// ========== 4. 持久化与容错 ==========

test('flush 落盘后可从磁盘按月文件读回', () => {
  const m = freshMetrics();
  m.record('p1', { tokensIn: 100, tokensOut: 50, tasks: 1, success: 1 });
  m.flush();
  const mk = m.monthKey(m.dayKey());
  assert.ok(fs.existsSync(monthFile(mk)));
  const raw = readMonth(mk);
  const dk = m.dayKey();
  assert.strictEqual(raw[dk].profiles.p1.tokensIn, 100);
  assert.strictEqual(raw[dk].profiles.p1.tokensOut, 50);
  assert.strictEqual(raw[dk].total.tokensIn, 100);
  assert.strictEqual(raw[dk].total.tokensOut, 50);
});

test('损坏的 JSON 文件不会抛错，重置为空并备份', () => {
  const m = freshMetrics();
  fs.mkdirSync(metricsDir(), { recursive: true });
  const mk = m.monthKey(m.dayKey());
  fs.writeFileSync(monthFile(mk), '{ 这不是合法 JSON', 'utf-8');
  // 触发载入
  const d = m.getDaily('p1');
  assert.strictEqual(d.tokensIn, 0);
  // 损坏文件被备份
  const backups = fs.readdirSync(metricsDir()).filter((f) => f.indexOf('.corrupt-') !== -1);
  assert.ok(backups.length >= 1);
  // 仍可正常记录
  m.record('p1', { tokensIn: 5 });
  assert.strictEqual(m.getDaily('p1').tokensIn, 5);
});

test('空数据安全：无文件时各读取 API 均不抛错', () => {
  const m = freshMetrics();
  assert.strictEqual(m.getDaily('p1').tokensIn, 0);
  assert.deepStrictEqual(m.getRange('p1', '2026-01-01', '2026-01-03').length, 3);
  const s = m.getSummary('p1');
  assert.strictEqual(s.today.tokensIn, 0);
  assert.strictEqual(s.week.tasks, 0);
  assert.strictEqual(s.month.fail, 0);
  // 区间内每天均为空
  for (const it of m.getRange('p1', '2026-01-01', '2026-01-03')) {
    assert.strictEqual(it.tokensIn, 0);
  }
});
