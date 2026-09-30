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

/** 重新加载 trace + retrospect（都走 mock 的 electron） */
function freshModules() {
  delete require.cache[require.resolve('../../src/main/team/trace')];
  delete require.cache[require.resolve('../../src/main/team/retrospect')];
  const retrospect = require('../../src/main/team/retrospect');
  const trace = require('../../src/main/team/trace');
  return { retrospect, trace };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-retrospect-'));
  installMock();
});
afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/team/trace')];
  delete require.cache[require.resolve('../../src/main/team/retrospect')];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

test('analyzeTrace：全成功轨迹', () => {
  const { retrospect } = freshModules();
  const tr = {
    taskId: 't1', goal: 'g', outcome: 'success',
    steps: [
      { seq: 1, tool: 'read', success: true, durationMs: 10 },
      { seq: 2, tool: 'write', success: true, durationMs: 20 },
    ],
  };
  const a = retrospect.analyzeTrace(tr);
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.summary.stepCount, 2);
  assert.strictEqual(a.summary.successCount, 2);
  assert.strictEqual(a.summary.failCount, 0);
  assert.strictEqual(a.summary.totalDurationMs, 30);
  assert.strictEqual(a.failureModes.length, 0);
  assert.strictEqual(a.findings.length, 0);
});

test('analyzeTrace：失败模式归并', () => {
  const { retrospect } = freshModules();
  const tr = {
    taskId: 't2', outcome: 'partial',
    steps: [
      { seq: 1, tool: 'bash', success: false, error: '命令不存在', durationMs: 5 },
      { seq: 2, tool: 'bash', success: false, error: '命令不存在', durationMs: 5 },
      { seq: 3, tool: 'read', success: true, durationMs: 3 },
    ],
  };
  const a = retrospect.analyzeTrace(tr);
  assert.strictEqual(a.summary.failCount, 2);
  assert.strictEqual(a.failureModes.length, 1);
  assert.strictEqual(a.failureModes[0].tool, 'bash');
  assert.strictEqual(a.failureModes[0].count, 2);
  assert.ok(a.findings.some(f => f.type === 'failure'));
});

test('analyzeTrace：重复调用（重试模式）', () => {
  const { retrospect } = freshModules();
  const tr = {
    taskId: 't3',
    steps: [
      { seq: 1, tool: 'read', args: 'a', success: true },
      { seq: 2, tool: 'read', args: 'a', success: true },
      { seq: 3, tool: 'read', args: 'a', success: true },
    ],
  };
  const a = retrospect.analyzeTrace(tr);
  assert.strictEqual(a.retries.length, 1);
  assert.strictEqual(a.retries[0].count, 3);
  assert.strictEqual(a.retries[0].tool, 'read');
  assert.ok(a.findings.some(f => f.type === 'retry'));
});

test('analyzeTrace：耗时热点', () => {
  const { retrospect } = freshModules();
  const tr = {
    taskId: 't4', outcome: 'success',
    steps: [
      { seq: 1, tool: 'read', success: true, durationMs: 10 },
      { seq: 2, tool: 'bash', success: true, durationMs: 5000 },
      { seq: 3, tool: 'read', success: true, durationMs: 10 },
    ],
  };
  const a = retrospect.analyzeTrace(tr);
  assert.ok(a.hotspots.some(h => h.tool === 'bash'));
  assert.ok(a.findings.some(f => f.type === 'hotspot'));
});

test('analyzeTrace：null / 空安全降级', () => {
  const { retrospect } = freshModules();
  const a = retrospect.analyzeTrace(null);
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.summary.stepCount, 0);
  assert.deepStrictEqual(a.findings, []);
});

test('analyzeTrace：接受 taskId 字符串（读磁盘）', () => {
  const { retrospect, trace } = freshModules();
  trace.beginTrace('t9', { goal: 'g9' });
  trace.recordStep('t9', { tool: 'read', success: true, durationMs: 1 });
  trace.endTrace('t9', {});
  const a = retrospect.analyzeTrace('t9');
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.summary.taskId, 't9');
  assert.strictEqual(a.summary.goal, 'g9');
});

test('buildRetrospectPrompt 返回含目标与结构的字符串', () => {
  const { retrospect } = freshModules();
  const tr = {
    taskId: 't5', goal: '修复登录',
    steps: [{ seq: 1, tool: 'read', success: true, durationMs: 5 }],
  };
  const p = retrospect.buildRetrospectPrompt(tr);
  assert.strictEqual(typeof p, 'string');
  assert.ok(p.indexOf('修复登录') !== -1);
  assert.ok(p.indexOf('可优化点') !== -1);
  assert.ok(p.indexOf('执行步骤明细') !== -1);
});

test('buildRetrospectPrompt：轨迹缺失也返回字符串（不抛）', () => {
  const { retrospect } = freshModules();
  const p = retrospect.buildRetrospectPrompt(null);
  assert.strictEqual(typeof p, 'string');
});

test('listOptimizableTraces：过滤全成功 + 排序 + limit', () => {
  const { retrospect, trace } = freshModules();

  trace.beginTrace('ok1', { goal: 'ok' });
  trace.recordStep('ok1', { tool: 'read', success: true });
  trace.endTrace('ok1', {});

  trace.beginTrace('bad1', { goal: 'bad1' });
  trace.recordStep('bad1', { tool: 'bash', success: false, error: 'e' });
  trace.recordStep('bad1', { tool: 'read', success: true });
  trace.endTrace('bad1', {});

  trace.beginTrace('bad2', { goal: 'bad2' });
  trace.recordStep('bad2', { tool: 'bash', success: false, error: 'e' });
  trace.endTrace('bad2', {});

  const list = retrospect.listOptimizableTraces();
  const ids = list.map(x => x.taskId);
  assert.ok(ids.indexOf('ok1') === -1, '全成功轨迹不应出现');
  assert.ok(ids.indexOf('bad1') !== -1);
  assert.ok(ids.indexOf('bad2') !== -1);
  assert.ok(ids.indexOf('bad2') < ids.indexOf('bad1'), 'failed 应排在 partial 前');

  assert.strictEqual(retrospect.listOptimizableTraces(1).length, 1);
});

test('scoreTrace：outcome 加权', () => {
  const { retrospect } = freshModules();
  assert.ok(retrospect.scoreTrace({ outcome: 'failed' }) > retrospect.scoreTrace({ outcome: 'partial' }));
  assert.ok(retrospect.scoreTrace({ outcome: 'partial' }) > retrospect.scoreTrace({ outcome: 'success' }));
  assert.strictEqual(retrospect.scoreTrace(null), 0);
});
