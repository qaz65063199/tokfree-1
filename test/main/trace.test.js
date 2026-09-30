'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const origLoad = Module._load;
let tmpDir;

function installMock() {
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => tmpDir } };
    }
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() { Module._load = origLoad; }

function fresh() {
  delete require.cache[require.resolve('../../src/main/team/trace')];
  return require('../../src/main/team/trace');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-trace-'));
  installMock();
});
afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/team/trace')];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

test('beginTrace + recordStep 累积步骤', () => {
  const t = fresh();
  t.beginTrace('task1', { profileId: 'p1', goal: '测试目标' });
  t.recordStep('task1', { tool: 'read', args: { file: 'a.js' }, success: true, durationMs: 10, outputSize: 100 });
  t.recordStep('task1', { tool: 'write', args: { file: 'b.js' }, success: false, error: '权限拒绝', durationMs: 5 });
  const tr = t.getTrace('task1');
  assert.strictEqual(tr.steps.length, 2);
  assert.strictEqual(tr.steps[0].tool, 'read');
  assert.strictEqual(tr.steps[0].success, true);
  assert.strictEqual(tr.steps[1].success, false);
  assert.strictEqual(tr.steps[1].error, '权限拒绝');
});

test('endTrace 落盘 + 索引', () => {
  const t = fresh();
  t.beginTrace('task2', { profileId: 'p2' });
  t.recordStep('task2', { tool: 'bash', success: true });
  t.recordStep('task2', { tool: 'bash', success: false, error: 'err' });
  t.endTrace('task2', {});
  const list = t.listTraces();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].taskId, 'task2');
  assert.strictEqual(list[0].stepCount, 2);
  assert.strictEqual(list[0].errorCount, 1);
  assert.strictEqual(list[0].outcome, 'partial');
});

test('全成功 → outcome=success', () => {
  const t = fresh();
  t.beginTrace('t3', {});
  t.recordStep('t3', { tool: 'a', success: true });
  t.endTrace('t3', {});
  assert.strictEqual(t.listTraces()[0].outcome, 'success');
});

test('全失败 → outcome=failed', () => {
  const t = fresh();
  t.beginTrace('t4', {});
  t.recordStep('t4', { tool: 'a', success: false, error: 'x' });
  t.endTrace('t4', {});
  assert.strictEqual(t.listTraces()[0].outcome, 'failed');
});

test('无 begin 直接 recordStep 自动补建', () => {
  const t = fresh();
  t.recordStep('t5', { tool: 'auto', success: true });
  const tr = t.getTrace('t5');
  assert.ok(tr);
  assert.strictEqual(tr.steps.length, 1);
});

test('长字段截断', () => {
  const t = fresh();
  t.beginTrace('t6', {});
  const longStr = 'x'.repeat(5000);
  t.recordStep('t6', { tool: 'read', args: { content: longStr }, success: true });
  const tr = t.getTrace('t6');
  assert.ok(tr.steps[0].args.length < 3000);
  assert.ok(tr.steps[0].args.indexOf('截断') !== -1);
});

test('hasActive 反映活跃状态', () => {
  const t = fresh();
  assert.strictEqual(t.hasActive('t7'), false);
  t.beginTrace('t7', {});
  assert.strictEqual(t.hasActive('t7'), true);
  t.endTrace('t7', {});
  assert.strictEqual(t.hasActive('t7'), false);
});

test('getTrace 落盘后可读回', () => {
  const t = fresh();
  t.beginTrace('t8', { profileId: 'p8', goal: 'g8' });
  t.recordStep('t8', { tool: 'read', success: true });
  t.endTrace('t8', {});
  // 新实例读回
  const t2 = fresh();
  const tr = t2.getTrace('t8');
  assert.ok(tr);
  assert.strictEqual(tr.goal, 'g8');
  assert.strictEqual(tr.steps.length, 1);
});

test('非法 taskId 安全处理', () => {
  const t = fresh();
  assert.strictEqual(t.beginTrace('', {}), null);
  assert.strictEqual(t.recordStep('', {}), false);
});
