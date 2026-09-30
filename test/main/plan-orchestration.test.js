'use strict';
/**
 * plan.js 多轮编排修复测试 —— 合并/孤儿依赖/持久化
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const origLoad = Module._load;
let tmpDir;

function installMock() {
  Module._load = function (request) {
    if (request === 'electron') return { app: { getPath: () => tmpDir } };
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() { Module._load = origLoad; }
function fresh() {
  delete require.cache[require.resolve('../../src/main/team/plan')];
  return require('../../src/main/team/plan');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-plan-'));
  installMock();
});
afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/team/plan')];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

test('★合并而非覆盖：重复 createPlan 保留已有模块完成状态', () => {
  const p = fresh();
  p.createPlan('m1', '目标', [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ]);
  // 标记 a 完成
  p.bindTaskToReadyModule('m1', 'task-a', 'a');
  p.markDoneByTaskId('task-a', 'ok');
  // 再 createPlan 追加 c（同一 plan）
  p.createPlan('m1', '目标', [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ]);
  const plan = p.getPlan('m1');
  const a = plan.modules.find(m => m.id === 'a');
  assert.strictEqual(a.status, 'done', 'a 应保留 done 状态');
  assert.strictEqual(plan.modules.length, 3, '应有 3 个模块');
});

test('孤儿依赖保持 pending（不掩盖依赖写错的真问题）', () => {
  const p = fresh();
  p.createPlan('m2', '目标', [
    { id: 'x', name: 'X', deps: ['不存在的模块'] },
  ]);
  const plan = p.getPlan('m2');
  assert.strictEqual(plan.modules[0].status, 'pending', '孤儿依赖应保持 pending');
});

test('正常依赖链：deps 未完成时 pending', () => {
  const p = fresh();
  p.createPlan('m3', '目标', [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B', deps: ['a'] },
  ]);
  const plan = p.getPlan('m3');
  assert.strictEqual(plan.modules.find(m => m.id === 'a').status, 'ready');
  assert.strictEqual(plan.modules.find(m => m.id === 'b').status, 'pending');
});

test('依赖完成后，下游变 ready', () => {
  const p = fresh();
  p.createPlan('m4', '目标', [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B', deps: ['a'] },
  ]);
  p.bindTaskToReadyModule('m4', 'ta', 'a');
  p.markDoneByTaskId('ta', 'ok');
  const plan = p.getPlan('m4');
  assert.strictEqual(plan.modules.find(m => m.id === 'b').status, 'ready');
});

test('持久化：计划落盘后重新加载恢复', () => {
  const p1 = fresh();
  p1.createPlan('m5', '持久目标', [{ id: 'a', name: 'A' }]);
  const file = path.join(tmpDir, 'plans.json');
  assert.ok(fs.existsSync(file), 'plans.json 应生成');

  // 清缓存重新加载
  delete require.cache[require.resolve('../../src/main/team/plan')];
  const p2 = require('../../src/main/team/plan');
  const plan = p2.getPlan('m5');
  assert.ok(plan, '重启后应恢复计划');
  assert.strictEqual(plan.goal, '持久目标');
});

test('markModuleDone 手动标记模块完成（支持 id 或 name）', () => {
  const p = fresh();
  p.createPlan('m7', '目标', [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B', deps: ['a'] },
  ]);
  const m = p.markModuleDone('m7', 'b', '手工完成');
  assert.ok(m, '应找到模块 b');
  assert.strictEqual(m.status, 'done');
  assert.strictEqual(p.getPlan('m7').modules.find(x => x.id === 'b').status, 'done');
});

test('markModuleDone 找不到模块返回 null', () => {
  const p = fresh();
  p.createPlan('m8', '目标', [{ id: 'a', name: 'A' }]);
  assert.strictEqual(p.markModuleDone('m8', '不存在'), null);
  assert.strictEqual(p.markModuleDone('m8', ''), null);
});

test('超时兜底：assigned 模块对应 task 长时间无活动 → 自动 failed', () => {
  const p = fresh();
  p.createPlan('m9', '目标', [{ id: 'a', name: 'A' }]);
  const tm = require('../../src/main/team/task-manager');
  tm._reset();
  const task = tm.createTask('w1', 'prompt', { masterProfileId: 'm9' });
  tm.updateTaskStatus(task.id, 'DISPATCHED');
  p.bindTaskToReadyModule('m9', task.id, 'A');
  // 把 task 的最后活动时间改为很久以前
  task.updatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  p._setAssignTimeoutMs(30 * 60 * 1000);
  const plan = p.getPlan('m9'); // 触发 refresh
  const m = plan.modules.find(x => x.id === 'a');
  assert.strictEqual(m.status, 'failed', '超时 assigned 应降级 failed');
  p._setAssignTimeoutMs(30 * 60 * 1000);
  tm._reset();
});

test('task 状态变 FAILED 时联动把模块标记 failed', () => {
  const p = fresh();
  p.createPlan('m10', '目标', [{ id: 'a', name: 'A' }]);
  const tm = require('../../src/main/team/task-manager');
  tm._reset();
  const task = tm.createTask('w1', 'prompt', { masterProfileId: 'm10' });
  tm.updateTaskStatus(task.id, 'DISPATCHED');
  p.bindTaskToReadyModule('m10', task.id, 'A');
  // 任务失败 → task-manager 应联动 plan.markFailedByTaskId
  tm.updateTaskStatus(task.id, 'FAILED', 'boom');
  const m = p.getPlan('m10').modules.find(x => x.id === 'a');
  assert.strictEqual(m.status, 'failed');
  tm._reset();
});

test('clearPlan 后落盘同步', () => {
  const p = fresh();
  p.createPlan('m6', '目标', [{ id: 'a', name: 'A' }]);
  p.clearPlan('m6');
  assert.strictEqual(p.getPlan('m6'), null);
  const arr = JSON.parse(fs.readFileSync(path.join(tmpDir, 'plans.json'), 'utf8'));
  assert.strictEqual(arr.length, 0);
});
