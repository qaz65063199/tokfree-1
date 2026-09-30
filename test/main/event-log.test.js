'use strict';
/**
 * event-log.js 单元测试
 *
 * event-log.js 依赖 electron 的 app.getPath('userData') 定位存储文件。
 * 参照 test/main/knowledge.test.js 的做法，用 Module._load 钩子 mock electron，
 * 把 userData 指向临时目录，隔离文件系统副作用。
 *
 * 注意：模块内部对 store/flushTimer 有状态缓存，每个测试需 freshEventLog()
 * 清除 require 缓存后重新 require；并用 flush() 强制立即落盘以便断言文件内容。
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

function freshEventLog() {
  delete require.cache[require.resolve('../../src/main/event-log')];
  return require('../../src/main/event-log');
}

function logFile() {
  return path.join(userDataDir, 'event-log.json');
}

function readRaw() {
  return JSON.parse(fs.readFileSync(logFile(), 'utf-8'));
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-evt-'));
  installMock();
});

afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/event-log')];
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
});

// ========== 1. 记录与读取 ==========

test('recordEvent 记录一条事件，getRecentEvents 可读回', () => {
  const el = freshEventLog();
  el.recordEvent({ profileId: 'p1', type: 'nag', sub: 'confirm', detail: '第1次' });
  const events = el.getRecentEvents();
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].profileId, 'p1');
  assert.strictEqual(events[0].type, 'nag');
  assert.strictEqual(events[0].sub, 'confirm');
  assert.strictEqual(events[0].detail, '第1次');
  assert.ok(typeof events[0].ts === 'number');
  assert.ok(events[0].meta && typeof events[0].meta === 'object');
});

test('recordEvent 缺少 type 返回 null 且不记录', () => {
  const el = freshEventLog();
  assert.strictEqual(el.recordEvent({ profileId: 'p1' }), null);
  assert.strictEqual(el.recordEvent(null), null);
  assert.strictEqual(el.getRecentEvents().length, 0);
});

test('getRecentEvents 默认返回最近 50 条且按时间正序', () => {
  const el = freshEventLog();
  for (let i = 0; i < 60; i++) {
    el.recordEvent({ profileId: 'p1', type: 'intercept', sub: 'codeblock', detail: 'e' + i });
  }
  const events = el.getRecentEvents();
  assert.strictEqual(events.length, 50);
  // 最近的一条是最后写入的 e59
  assert.strictEqual(events[events.length - 1].detail, 'e59');
  // 最早保留的是 e10（60 条丢最旧 10 条）
  assert.strictEqual(events[0].detail, 'e10');
});

test('getRecentEvents 支持 limit', () => {
  const el = freshEventLog();
  for (let i = 0; i < 10; i++) {
    el.recordEvent({ profileId: 'p1', type: 'nag', sub: 'interrupt' });
  }
  assert.strictEqual(el.getRecentEvents(3).length, 3);
});

// ========== 2. 限长 ==========

test('事件限长 500 条，超出丢最旧', () => {
  const el = freshEventLog();
  for (let i = 0; i < 520; i++) {
    el.recordEvent({ profileId: 'p1', type: 'intercept', sub: 'codeblock', detail: 'n' + i });
  }
  const events = el.getRecentEvents(1000);
  assert.strictEqual(events.length, 500);
  assert.strictEqual(events[events.length - 1].detail, 'n519');
  assert.strictEqual(events[0].detail, 'n20');
});

// ========== 3. 统计 ==========

test('getDailyStats 按 profile 按天统计', () => {
  const el = freshEventLog();
  el.recordEvent({ profileId: 'p1', type: 'nag', sub: 'confirm' });
  el.recordEvent({ profileId: 'p1', type: 'nag', sub: 'interrupt' });
  el.recordEvent({ profileId: 'p1', type: 'dispatch' });
  el.recordEvent({ profileId: 'p2', type: 'done' });
  const d1 = el.getDailyStats('p1');
  assert.strictEqual(d1.nag, 2);
  assert.strictEqual(d1.dispatch, 1);
  assert.strictEqual(d1.done, 0);
  const d2 = el.getDailyStats('p2');
  assert.strictEqual(d2.done, 1);
  assert.strictEqual(d2.nag, 0);
});

test('getAllDailyStats 汇总所有窗口', () => {
  const el = freshEventLog();
  el.recordEvent({ profileId: 'p1', type: 'nag' });
  el.recordEvent({ profileId: 'p2', type: 'nag' });
  el.recordEvent({ profileId: 'p2', type: 'intercept' });
  const all = el.getAllDailyStats();
  assert.strictEqual(all.nag, 2);
  assert.strictEqual(all.intercept, 1);
  assert.strictEqual(all.dispatch, 0);
});

test('getSummary 聚合事件统计并读取会话收发', () => {
  const el = freshEventLog();
  el.recordEvent({ profileId: 'p1', type: 'nag' });
  el.recordEvent({ profileId: 'p1', type: 'intercept' });
  el.recordEvent({ profileId: 'p1', type: 'dispatch' });
  el.recordEvent({ profileId: 'p1', type: 'done' });
  // 写一份 conversation-stats.json
  const day = el.todayKey();
  fs.writeFileSync(path.join(userDataDir, 'conversation-stats.json'), JSON.stringify({
    p1: { [day]: { sent: 7, received: 5 } },
  }), 'utf-8');
  const s = el.getSummary();
  assert.strictEqual(s.nag, 1);
  assert.strictEqual(s.intercept, 1);
  assert.strictEqual(s.dispatch, 1);
  assert.strictEqual(s.done, 1);
  assert.strictEqual(s.sent, 7);
  assert.strictEqual(s.received, 5);
});

test('getSummary 无会话计数文件时 sent/received 为 0', () => {
  const el = freshEventLog();
  el.recordEvent({ profileId: 'p1', type: 'nag' });
  const s = el.getSummary();
  assert.strictEqual(s.sent, 0);
  assert.strictEqual(s.received, 0);
  assert.strictEqual(s.nag, 1);
});

// ========== 4. 持久化与容错 ==========

test('flush 落盘后可从磁盘读回', () => {
  const el = freshEventLog();
  el.recordEvent({ profileId: 'p1', type: 'dispatch', meta: { taskId: 't1', module: 'm1' } });
  el.flush();
  assert.ok(fs.existsSync(logFile()));
  const raw = readRaw();
  assert.strictEqual(raw.events.length, 1);
  assert.strictEqual(raw.events[0].meta.taskId, 't1');
  assert.strictEqual(raw.daily.p1[el.todayKey()].dispatch, 1);
});

test('损坏的 JSON 文件不会抛错，重置为空', () => {
  fs.writeFileSync(logFile(), '{ 这不是合法 JSON', 'utf-8');
  const el = freshEventLog();
  assert.strictEqual(el.getRecentEvents().length, 0);
  // 仍可正常记录
  el.recordEvent({ profileId: 'p1', type: 'nag' });
  assert.strictEqual(el.getRecentEvents().length, 1);
});

test('结构异常的 JSON（events 非数组）被规范化', () => {
  fs.writeFileSync(logFile(), JSON.stringify({ events: 'oops', daily: null }), 'utf-8');
  const el = freshEventLog();
  assert.strictEqual(el.getRecentEvents().length, 0);
  el.recordEvent({ profileId: 'p1', type: 'nag' });
  assert.strictEqual(el.getDailyStats('p1').nag, 1);
});
