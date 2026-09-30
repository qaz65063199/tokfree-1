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
  Module._load = function (request) {
    if (request === 'electron') return { app: { getPath: () => tmpDir } };
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() { Module._load = origLoad; }
function fresh() {
  delete require.cache[require.resolve('../../src/main/team/deliverable')];
  delete require.cache[require.resolve('../../src/main/team/self-loop')];
  return { d: require('../../src/main/team/deliverable'), sl: require('../../src/main/team/self-loop') };
}

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-deliv-')); installMock(); });
afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/team/deliverable')];
  delete require.cache[require.resolve('../../src/main/team/self-loop')];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

test('buildGoalReport 达标时生成报告', () => {
  const { d, sl } = fresh();
  const g = sl.createGoal({ title: '完成功能', successCriteria: ['功能完整', '测试通过'] }).goal;
  sl.recordRound(g.id, { evidence: { criteriaResults: { '功能完整': true, '测试通过': true } }, note: '一次搞定' });
  const report = d.buildGoalReport(g.id);
  assert.ok(report.indexOf('目标达成报告') !== -1);
  assert.ok(report.indexOf('完成功能') !== -1);
  assert.ok(report.indexOf('✅') !== -1);
});

test('buildProgressReport 中途汇报', () => {
  const { d, sl } = fresh();
  const g = sl.createGoal({ title: 'T', successCriteria: ['a'] }).goal;
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: false } }, actions: ['execute'] });
  const r = d.buildProgressReport(g.id);
  assert.ok(r.indexOf('目标进展') !== -1);
  assert.ok(r.indexOf('第 1 轮') !== -1);
});

test('buildAllGoalsSummary 汇总', () => {
  const { d, sl } = fresh();
  sl.createGoal({ title: 'G1' });
  sl.createGoal({ title: 'G2' });
  const s = d.buildAllGoalsSummary();
  assert.ok(s.indexOf('G1') !== -1);
  assert.ok(s.indexOf('G2') !== -1);
});

test('shouldNotify 达标 → success', () => {
  const { d, sl } = fresh();
  const g = sl.createGoal({ title: 'T' }).goal;
  const n = d.shouldNotify(g.id, 'achieved');
  assert.strictEqual(n.notify, true);
  assert.strictEqual(n.level, 'success');
});

test('shouldNotify 熔断 → warn', () => {
  const { d, sl } = fresh();
  const g = sl.createGoal({ title: 'T' }).goal;
  const n = d.shouldNotify(g.id, 'circuit-break');
  assert.strictEqual(n.level, 'warn');
});

test('不存在的目标安全返回', () => {
  const { d } = fresh();
  assert.strictEqual(d.buildGoalReport('nonexistent'), '');
  assert.strictEqual(d.shouldNotify('nonexistent', 'achieved').notify, false);
});
