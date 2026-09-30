'use strict';
/**
 * src/main/team/plan.js 单元测试
 * 纯状态模块（不依赖 electron），直接 require。
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const plan = require('../../src/main/team/plan');

beforeEach(() => {
  plan._reset();
});

test('createPlan 建立模块并刷新状态', () => {
  const p = plan.createPlan('m1', '目标A', [
    { name: 'mod1' },
    { name: 'mod2', deps: ['mod1'] },
  ]);
  assert.strictEqual(p.masterProfileId, 'm1');
  assert.strictEqual(p.goal, '目标A');
  assert.strictEqual(p.modules.length, 2);
  assert.strictEqual(p.modules[0].status, 'ready');
  assert.strictEqual(p.modules[1].status, 'pending');
});

test('依赖满足后自动变 ready', () => {
  plan.createPlan('m1', 'g', [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B', deps: ['a'] },
  ]);
  assert.strictEqual(plan.getPlan('m1').modules[1].status, 'pending');
  plan.bindTaskToReadyModule('m1', 'task-a', 'A');
  plan.markDoneByTaskId('task-a', 'ok');
  const p2 = plan.getPlan('m1');
  assert.strictEqual(p2.modules[0].status, 'done');
  assert.strictEqual(p2.modules[1].status, 'ready');
});

test('bindTaskToReadyModule 按 module 名匹配', () => {
  plan.createPlan('m1', 'g', [
    { id: 'a', name: 'Auth' },
    { id: 'b', name: 'DB' },
  ]);
  const bound = plan.bindTaskToReadyModule('m1', 'task-db', 'DB');
  assert.ok(bound);
  assert.strictEqual(bound.name, 'DB');
  assert.strictEqual(bound.status, 'assigned');
  assert.strictEqual(bound.taskId, 'task-db');
});

test('bindTaskToReadyModule 无提示取第一个 ready', () => {
  plan.createPlan('m1', 'g', [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ]);
  const bound = plan.bindTaskToReadyModule('m1', 't1', '');
  assert.strictEqual(bound.name, 'A');
});

test('markDoneByTaskId 标记完成', () => {
  plan.createPlan('m1', 'g', [{ id: 'a', name: 'A' }]);
  plan.bindTaskToReadyModule('m1', 't1', 'A');
  assert.strictEqual(plan.markDoneByTaskId('t1', 'done'), true);
  assert.strictEqual(plan.getPlan('m1').modules[0].status, 'done');
});

test('markFailedByTaskId 标记失败', () => {
  plan.createPlan('m1', 'g', [{ id: 'a', name: 'A' }]);
  plan.bindTaskToReadyModule('m1', 't1', 'A');
  assert.strictEqual(plan.markFailedByTaskId('t1', 'err'), true);
  assert.strictEqual(plan.getPlan('m1').modules[0].status, 'failed');
});

test('listActivePlans 只返回未全完成的计划', () => {
  plan.createPlan('m1', 'g', [{ id: 'a', name: 'A' }]);
  plan.createPlan('m2', 'g2', [{ id: 'b', name: 'B' }]);
  plan.bindTaskToReadyModule('m1', 't1', 'A');
  plan.markDoneByTaskId('t1', 'ok');
  const active = plan.listActivePlans();
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].masterProfileId, 'm2');
});

test('getSummary 含目标与统计', () => {
  plan.createPlan('m1', '总目标', [{ id: 'a', name: 'A' }]);
  const s = plan.getSummary(plan.getPlan('m1'));
  assert.ok(s.indexOf('总目标') !== -1);
  assert.ok(s.indexOf('统计') !== -1);
});

test('clearPlan 删除计划', () => {
  plan.createPlan('m1', 'g', [{ id: 'a', name: 'A' }]);
  assert.ok(plan.getPlan('m1'));
  plan.clearPlan('m1');
  assert.strictEqual(plan.getPlan('m1'), null);
});

test('createPlan 缺 masterProfileId 抛错', () => {
  assert.throws(() => plan.createPlan('', 'g', [{ name: 'a' }]));
});

test('多依赖：任一未完成则仍 pending', () => {
  plan.createPlan('m1', 'g', [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C', deps: ['a', 'b'] },
  ]);
  plan.bindTaskToReadyModule('m1', 'ta', 'A');
  plan.markDoneByTaskId('ta');
  assert.strictEqual(plan.getPlan('m1').modules[2].status, 'pending');
  plan.bindTaskToReadyModule('m1', 'tb', 'B');
  plan.markDoneByTaskId('tb');
  assert.strictEqual(plan.getPlan('m1').modules[2].status, 'ready');
});
