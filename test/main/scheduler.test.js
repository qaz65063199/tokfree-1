'use strict';
/**
 * src/main/team/scheduler.js 单元测试
 * 重点测 buildNudge 的决策逻辑（纯函数，注入 mock 依赖）。
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const origLoad = Module._load;
let mockTasks = new Map();
let mockActivity = new Map();

function installMock() {
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => require('os').tmpdir() } };
    }
    if (request === '../window' || request === './window') {
      return {
        getWindowByProfileId: () => null,
        getMainContext: () => null,
        getAllContexts: () => [],
      };
    }
    if (request === '../watchdog' || request === './watchdog') {
      return { getStatus: () => ({ profile: { expectingReply: false, busy: false, mode: 'idle' } }) };
    }
    if (request === './task-manager' || request === '../task-manager') {
      return { getTask: (id) => mockTasks.get(id) || null };
    }
    if (request === '../worker-activity') {
      return { getAgoSeconds: (pid) => (mockActivity.has(pid) ? mockActivity.get(pid) : null) };
    }
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() { Module._load = origLoad; }

function freshScheduler() {
  delete require.cache[require.resolve('../../src/main/team/scheduler')];
  delete require.cache[require.resolve('../../src/main/team/plan')];
  return require('../../src/main/team/scheduler');
}
function freshPlan() {
  delete require.cache[require.resolve('../../src/main/team/plan')];
  const p = require('../../src/main/team/plan');
  // 清内存 + 删落盘文件，保证测试隔离（plan 有持久化，会跨测试污染）
  try { p._reset(); } catch (_) {}
  return p;
}

beforeEach(() => {
  mockTasks = new Map();
  mockActivity = new Map();
  installMock();
});
afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/team/scheduler')];
  delete require.cache[require.resolve('../../src/main/team/plan')];
});

test('全完成 → 催验收', () => {
  const sched = freshScheduler();
  const plan = freshPlan();
  plan.createPlan('m1', '目标', [{ id: 'a', name: 'A' }]);
  plan.bindTaskToReadyModule('m1', 't1', 'A');
  plan.markDoneByTaskId('t1');
  const msg = sched.buildNudge(plan.getPlan('m1'));
  assert.ok(msg && msg.indexOf('全部完成') !== -1);
});

test('有 ready 且无 assigned → 催派活', () => {
  const sched = freshScheduler();
  const plan = freshPlan();
  plan.createPlan('m1', '目标', [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const msg = sched.buildNudge(plan.getPlan('m1'));
  assert.ok(msg && msg.indexOf('可派发') !== -1);
});

test('有 assigned 且不卡 → null（不打扰）', () => {
  const sched = freshScheduler();
  const plan = freshPlan();
  plan.createPlan('m1', '目标', [{ id: 'a', name: 'A' }]);
  plan.bindTaskToReadyModule('m1', 't1', 'A');
  mockTasks.set('t1', { id: 't1', profileId: 'w1' });
  mockActivity.set('w1', 10);
  const msg = sched.buildNudge(plan.getPlan('m1'));
  assert.strictEqual(msg, null);
});

test('assigned 全卡住 → 催核实', () => {
  const sched = freshScheduler();
  const plan = freshPlan();
  plan.createPlan('m1', '目标', [{ id: 'a', name: 'A' }]);
  plan.bindTaskToReadyModule('m1', 't1', 'A');
  mockTasks.set('t1', { id: 't1', profileId: 'w1' });
  mockActivity.set('w1', 600);
  const msg = sched.buildNudge(plan.getPlan('m1'));
  assert.ok(msg && msg.indexOf('卡住') !== -1);
});

test('有 failed → 催决策', () => {
  const sched = freshScheduler();
  const plan = freshPlan();
  plan.createPlan('m1', '目标', [{ id: 'a', name: 'A' }]);
  plan.bindTaskToReadyModule('m1', 't1', 'A');
  plan.markFailedByTaskId('t1', 'err');
  const msg = sched.buildNudge(plan.getPlan('m1'));
  assert.ok(msg && msg.indexOf('失败') !== -1);
});

test('assigned 存在且不卡时优先等待（返回 null）', () => {
  const sched = freshScheduler();
  const plan = freshPlan();
  plan.createPlan('m2', '目标2', [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y', deps: ['x'] }]);
  plan.bindTaskToReadyModule('m2', 'tx', 'X');
  mockTasks.set('tx', { id: 'tx', profileId: 'w2' });
  mockActivity.set('w2', 10);
  const msg = sched.buildNudge(plan.getPlan('m2'));
  assert.strictEqual(msg, null);
});

test('空模块计划 → 返回 null', () => {
  const sched = freshScheduler();
  const plan = freshPlan();
  const p = plan.createPlan('m1', '目标', [{ id: 'a', name: 'A' }]);
  p.modules = [];
  const msg = sched.buildNudge(plan.getPlan('m1'));
  assert.strictEqual(msg, null);
});
