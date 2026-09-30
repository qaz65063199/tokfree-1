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
  delete require.cache[require.resolve('../../src/main/team/skill-evolver')];
  return require('../../src/main/team/skill-evolver');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-evolver-'));
  installMock();
});
afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/team/skill-evolver')];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

test('recordUsage 累积使用数据', () => {
  const e = fresh();
  e.recordUsage('s1', { success: true, durationMs: 100 });
  e.recordUsage('s1', { success: false, durationMs: 200 });
  const st = e.getStat('s1');
  assert.strictEqual(st.uses, 2);
  assert.strictEqual(st.success, 1);
  assert.strictEqual(st.fail, 1);
  assert.strictEqual(st.totalMs, 300);
});

test('successRate 计算', () => {
  const e = fresh();
  e.recordUsage('s2', { success: true });
  e.recordUsage('s2', { success: true });
  e.recordUsage('s2', { success: false });
  assert.ok(Math.abs(e.successRate(e.getStat('s2')) - 2/3) < 0.01);
});

test('avgDuration 计算', () => {
  const e = fresh();
  e.recordUsage('s3', { success: true, durationMs: 100 });
  e.recordUsage('s3', { success: true, durationMs: 300 });
  assert.strictEqual(e.avgDuration(e.getStat('s3')), 200);
});

test('无使用返回 null', () => {
  const e = fresh();
  assert.strictEqual(e.successRate(null), null);
  assert.strictEqual(e.avgDuration(null), null);
  assert.strictEqual(e.getStat('never'), null);
});

test('analyze 识别低成功率需优化', () => {
  const e = fresh();
  // 5 次使用 3 次失败 → 40%
  for (let i = 0; i < 3; i++) e.recordUsage('bad', { success: false });
  for (let i = 0; i < 2; i++) e.recordUsage('bad', { success: true });
  const a = e.analyze();
  assert.ok(a.needOptimize.some(x => x.name === 'bad'));
});

test('analyze 识别健康技能', () => {
  const e = fresh();
  for (let i = 0; i < 5; i++) e.recordUsage('good', { success: true, durationMs: 100 });
  const a = e.analyze();
  assert.ok(a.healthy.some(x => x.name === 'good'));
});

test('新技能（使用次数少）不评估淘汰', () => {
  const e = fresh();
  e.recordUsage('new', { success: false });
  const a = e.analyze();
  assert.strictEqual(a.archiveCandidates.length, 0);
});

test('长期不用+低成功率 → 淘汰候选', () => {
  const e = fresh();
  // 手动构造：用过 5 次、成功 1 次、lastUsedAt 很久以前
  const kdir = path.join(tmpDir, 'knowledge');
  if (!fs.existsSync(kdir)) fs.mkdirSync(kdir, { recursive: true });
  const db = { stats: { old: { uses: 5, success: 1, fail: 4, totalMs: 0, lastUsedAt: Date.now() - 40 * 86400000, createdAt: Date.now() - 50 * 86400000, archived: false } } };
  fs.writeFileSync(path.join(kdir, 'skill-stats.json'), JSON.stringify(db), 'utf-8');
  const cands = e.listArchiveCandidates();
  assert.ok(cands.some(x => x.name === 'old'));
});

test('clearStats 清空', () => {
  const e = fresh();
  e.recordUsage('x', { success: true });
  e.clearStats();
  assert.strictEqual(e.listStats().length, 0);
});

test('非法技能名安全处理', () => {
  const e = fresh();
  assert.strictEqual(e.recordUsage('', {}).success, false);
  assert.strictEqual(e.recordUsage(null, {}).success, false);
});
