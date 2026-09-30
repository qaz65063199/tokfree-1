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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-trace-h-'));
  installMock();
});
afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/team/trace')];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

test('recordStep 带 parentId（显式参数）', () => {
  const t = fresh();
  t.beginTrace('h1', {});
  t.recordStep('h1', { tool: 'root', type: 'agent-turn' });
  t.recordStep('h1', { tool: 'child', type: 'tool-call' }, 's1');
  const tr = t.getTrace('h1');
  assert.strictEqual(tr.steps.length, 2);
  assert.strictEqual(tr.steps[0].parentId, null);
  assert.strictEqual(tr.steps[1].parentId, 's1');
});

test('recordStep 从 step.parentId 取父 id', () => {
  const t = fresh();
  t.beginTrace('h2', {});
  t.recordStep('h2', { tool: 'a', type: 'agent-turn' });
  t.recordStep('h2', { tool: 'b', parentId: 's1' });
  const tr = t.getTrace('h2');
  assert.strictEqual(tr.steps[1].parentId, 's1');
});

test('type 缺省为 event，durationMs 缺省为 0', () => {
  const t = fresh();
  t.beginTrace('h3', {});
  t.recordStep('h3', { tool: 'x' });
  const tr = t.getTrace('h3');
  assert.strictEqual(tr.steps[0].type, 'event');
  assert.strictEqual(tr.steps[0].durationMs, 0);
});

test('type/durationMs 显式值被保留', () => {
  const t = fresh();
  t.beginTrace('h4', {});
  t.recordStep('h4', { tool: 'x', type: 'tool-call', durationMs: 42 });
  const tr = t.getTrace('h4');
  assert.strictEqual(tr.steps[0].type, 'tool-call');
  assert.strictEqual(tr.steps[0].durationMs, 42);
});

test('step 自动分配 id（s+seq）', () => {
  const t = fresh();
  t.beginTrace('h5', {});
  t.recordStep('h5', { tool: 'a' });
  t.recordStep('h5', { tool: 'b' });
  const tr = t.getTrace('h5');
  assert.strictEqual(tr.steps[0].id, 's1');
  assert.strictEqual(tr.steps[1].id, 's2');
});

test('旧数据兼容：无 parentId/type/durationMs 读取补默认值', () => {
  const t = fresh();
  // 手工写入旧格式轨迹文件
  const dir = path.join(tmpDir, 'traces');
  fs.mkdirSync(dir, { recursive: true });
  const legacy = {
    taskId: 'legacy1',
    profileId: 'p',
    goal: 'g',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    outcome: 'success',
    summary: '',
    steps: [
      { seq: 1, ts: '2020-01-01T00:00:00.000Z', tool: 'read', args: 'x', success: true, error: '' },
      { seq: 2, ts: '2020-01-01T00:00:01.000Z', tool: 'write', success: false, error: 'e', durationMs: 7 },
    ],
  };
  fs.writeFileSync(path.join(dir, 'legacy1.json'), JSON.stringify(legacy), 'utf-8');
  // 新实例读回
  const t2 = fresh();
  const tr = t2.getTrace('legacy1');
  assert.ok(tr);
  assert.strictEqual(tr.steps[0].parentId, null);
  assert.strictEqual(tr.steps[0].type, 'event');
  assert.strictEqual(tr.steps[0].durationMs, 0);
  assert.strictEqual(tr.steps[0].id, 's1');
  // 有 durationMs 的保留
  assert.strictEqual(tr.steps[1].durationMs, 7);
  assert.strictEqual(tr.steps[1].parentId, null);
});

test('层级关系正确：可据 parentId 重建父子树', () => {
  const t = fresh();
  t.beginTrace('h6', {});
  t.recordStep('h6', { tool: 'turn', type: 'agent-turn' });       // s1 root
  t.recordStep('h6', { tool: 'call1', type: 'tool-call' }, 's1'); // s2 child of s1
  t.recordStep('h6', { tool: 'evt', type: 'event' }, 's2');       // s3 child of s2
  t.recordStep('h6', { tool: 'call2', type: 'tool-call' }, 's1'); // s4 child of s1
  const tr = t.getTrace('h6');
  const byParent = {};
  tr.steps.forEach(function (s) {
    const k = s.parentId === null ? 'root' : s.parentId;
    (byParent[k] = byParent[k] || []).push(s.id);
  });
  assert.deepStrictEqual(byParent['root'], ['s1']);
  assert.deepStrictEqual(byParent['s1'], ['s2', 's4']);
  assert.deepStrictEqual(byParent['s2'], ['s3']);
});
