'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Module = require('module');

// 用临时目录隔离持久化文件
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-test-'));
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => tmp } };
  return origLoad.apply(this, arguments);
};

const st = require('../../src/main/scheduled-tasks');

/** 每个用例开始前清空内存状态 + 删除持久化文件，保证隔离 */
function fresh() {
  st._reset();
}

/** 每个用例结束后清理持久化文件，避免跨用例残留 */
afterEach(() => {
  st._reset();
});

test('createTask 创建并持久化（once）', () => {
  fresh();
  const t = st.createTask({ name: 'A', prompt: 'hi', type: 'once', atMs: Date.now() + 100000 });
  assert.ok(t.id);
  assert.strictEqual(t.type, 'once');
  assert.strictEqual(t.enabled, true);
  const list = st.listTasks();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'A');
});

test('createTask interval 默认与显式间隔', () => {
  fresh();
  const t1 = st.createTask({ name: 'B', prompt: 'x', type: 'interval' });
  assert.strictEqual(t1.intervalMinutes, 30);
  const t2 = st.createTask({ name: 'C', prompt: 'x', type: 'interval', intervalMinutes: 5 });
  assert.strictEqual(t2.intervalMinutes, 5);
  assert.strictEqual(st.listTasks().length, 2);
});

test('removeTask 删除 / 不存在返回 false', () => {
  fresh();
  const t = st.createTask({ name: 'D', prompt: 'x', type: 'interval' });
  assert.strictEqual(st.removeTask('nope'), false);
  assert.strictEqual(st.removeTask(t.id), true);
  assert.strictEqual(st.listTasks().length, 0);
});

test('toggleTask 启停', () => {
  fresh();
  const t = st.createTask({ name: 'E', prompt: 'x', type: 'interval' });
  assert.strictEqual(st.toggleTask(t.id, false), true);
  assert.strictEqual(st.listTasks()[0].enabled, false);
  assert.strictEqual(st.toggleTask('nope', true), false);
});

test('isDue：once 到点 / 未到点', () => {
  const now = 1000000;
  assert.strictEqual(st.isDue({ enabled: true, type: 'once', atMs: now - 1 }, now), true);
  assert.strictEqual(st.isDue({ enabled: true, type: 'once', atMs: now + 1 }, now), false);
  assert.strictEqual(st.isDue({ enabled: false, type: 'once', atMs: now - 1 }, now), false);
});

test('isDue：interval 到期 / 未到期', () => {
  const now = 1000000;
  // 上次执行在 10 分钟前，间隔 5 分钟 → 到期
  assert.strictEqual(st.isDue({ enabled: true, type: 'interval', intervalMinutes: 5, lastRunAt: now - 10 * 60000 }, now), true);
  // 上次执行在 1 分钟前，间隔 5 分钟 → 未到期
  assert.strictEqual(st.isDue({ enabled: true, type: 'interval', intervalMinutes: 5, lastRunAt: now - 60000 }, now), false);
  // 从未执行过（lastRunAt=0），用 createdAt 兜底
  assert.strictEqual(st.isDue({ enabled: true, type: 'interval', intervalMinutes: 5, createdAt: now - 10 * 60000, lastRunAt: 0 }, now), true);
});

test('tick：once 到点执行一次后置 enabled=false 且 runCount+1', () => {
  fresh();
  const now = Date.now();
  const t = st.createTask({ name: 'F', prompt: 'p', type: 'once', atMs: now - 1000 });
  const res = st.tick(now);
  assert.ok(res.length >= 1);
  const after = st.listTasks().find((x) => x.id === t.id);
  assert.strictEqual(after.enabled, false);
  assert.strictEqual(after.runCount, 1);
  // 再 tick 不应再执行
  const res2 = st.tick(now);
  assert.strictEqual(res2.length, 0);
});

test('tick：interval 到期执行并累加 runCount', () => {
  fresh();
  const now = Date.now();
  // 直接写入一个 createdAt 为 10 分钟前的 interval 任务，使其立即到期
  const task = {
    id: 'g2', name: 'G2', prompt: 'p', profileId: '', type: 'interval',
    enabled: true, lastRunAt: 0, runCount: 0,
    createdAt: now - 10 * 60000, intervalMinutes: 5,
  };
  fs.writeFileSync(st.getFilePath(), JSON.stringify({ tasks: [task] }), 'utf-8');
  const res = st.tick(now);
  assert.ok(res.length >= 1);
  const after = st.listTasks().find((x) => x.id === 'g2');
  assert.strictEqual(after.runCount, 1);
  assert.strictEqual(after.enabled, true, 'interval 任务执行后仍启用');
});

test('损坏 JSON 容错：重置为空', () => {
  fresh();
  fs.writeFileSync(st.getFilePath(), '{ not valid json', 'utf-8');
  const list = st.listTasks();
  assert.deepStrictEqual(list, []);
});

test('空列表安全：tick 无任务返回空数组', () => {
  fresh();
  const res = st.tick();
  assert.deepStrictEqual(res, []);
});

