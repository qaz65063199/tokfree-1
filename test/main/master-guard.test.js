'use strict';
/**
 * master-guard 测试：多 Agent 模式下检测"主大脑忘记派活、自己埋头干"
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const origLoad = Module._load;
let multi = true;
let master = true;
let freeWorker = true;

function installMock() {
  Module._load = function (request) {
    if (request === './mode' || request === '../mode') {
      return { isMulti: () => multi };
    }
    if (request === './task-manager' || request === '../task-manager') {
      return { listActiveTasks: () => master ? [{ id: 't1' }] : [] };
    }
    if (request === './plan' || request === '../plan') {
      return { getPlan: () => master ? { modules: [{ status: 'assigned' }] } : null, refresh: () => {} };
    }
    if (request === '../window' || request === './window') {
      return { getAllContexts: () => freeWorker ? [{ profileId: 'p1' }, { profileId: 'w1' }] : [{ profileId: 'p1' }] };
    }
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() { Module._load = origLoad; }
function fresh() {
  delete require.cache[require.resolve('../../src/main/team/master-guard')];
  return require('../../src/main/team/master-guard');
}

beforeEach(() => {
  multi = true; master = true; freeWorker = true;
  installMock();
});
afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/team/master-guard')];
});

test('单聊模式 → 不提醒', () => {
  multi = false;
  const mg = fresh();
  for (let i = 0; i < 5; i++) mg.noteSelfWork('p1', 'await write("a.js","x")');
  assert.strictEqual(mg.noteSelfWork('p1', 'await write("a.js","x")').shouldNudge, false);
});

test('非主大脑（无活跃任务）→ 不提醒', () => {
  master = false;
  const mg = fresh();
  for (let i = 0; i < 5; i++) mg.noteSelfWork('p1', 'await write("a.js","x")');
  assert.strictEqual(mg.noteSelfWork('p1', 'await write("a.js","x")').shouldNudge, false);
});

test('无空闲 Worker → 不提醒（无人可派，只能自己干）', () => {
  freeWorker = false;
  const mg = fresh();
  for (let i = 0; i < 5; i++) mg.noteSelfWork('p1', 'await write("a.js","x")');
  assert.strictEqual(mg.noteSelfWork('p1', 'await write("a.js","x")').shouldNudge, false);
});

test('★多Agent+主大脑+有Worker：连续自干达阈值 → 提醒', () => {
  const mg = fresh();
  const r1 = mg.noteSelfWork('p1', 'await write("a.js","x")');
  const r2 = mg.noteSelfWork('p1', 'await write("a.js","x")');
  const r3 = mg.noteSelfWork('p1', 'await write("a.js","x")');
  assert.strictEqual(r1.shouldNudge, false, '第1次不提醒');
  assert.strictEqual(r2.shouldNudge, false, '第2次不提醒');
  assert.strictEqual(r3.shouldNudge, true, '第3次（达阈值）应提醒');
  assert.strictEqual(r3.count, 3);
});

test('提醒后重置计数（不刷屏）', () => {
  const mg = fresh();
  mg.noteSelfWork('p1', 'await write("a.js","x")');
  mg.noteSelfWork('p1', 'await write("a.js","x")');
  const r3 = mg.noteSelfWork('p1', 'await write("a.js","x")');
  assert.strictEqual(r3.shouldNudge, true);
  // 提醒后计数清零，再连干 2 次不提醒
  assert.strictEqual(mg.noteSelfWork('p1', 'await write("a.js","x")').shouldNudge, false);
  assert.strictEqual(mg.noteSelfWork('p1', 'await write("a.js","x")').shouldNudge, false);
});

test('★管理操作(team_*)不算自干', () => {
  const mg = fresh();
  for (let i = 0; i < 5; i++) mg.noteSelfWork('p1', 'await team_dispatch_batch([])');
  const r = mg.noteSelfWork('p1', 'await team_get_workers_status()');
  assert.strictEqual(r.shouldNudge, false);
});

test('★只读操作不算自干', () => {
  const mg = fresh();
  for (let i = 0; i < 5; i++) mg.noteSelfWork('p1', 'const x = await read(p); log(x);');
  const r = mg.noteSelfWork('p1', 'await grep(p, o)');
  assert.strictEqual(r.shouldNudge, false);
});

test('提醒语包含"派发/Worker"关键词', () => {
  const mg = fresh();
  const msg = mg.buildNudge();
  assert.ok(msg.includes('Worker'));
  assert.ok(msg.includes('派发') || msg.includes('team_dispatch'));
});
