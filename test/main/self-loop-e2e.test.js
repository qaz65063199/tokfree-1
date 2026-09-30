'use strict';
/**
 * 自驱循环端到端测试 —— 验证"无人干预持续进化"完整闭环
 * 串起：self-loop + guard + evolution-boundary + deliverable
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
function fresh(mods) {
  const out = {};
  for (const m of mods) {
    delete require.cache[require.resolve('../../src/main/team/' + m)];
    out[m] = require('../../src/main/team/' + m);
  }
  return out;
}

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-e2e-loop-')); installMock(); });
afterEach(() => {
  uninstallMock();
  for (const m of ['self-loop', 'self-loop-guard', 'evolution-boundary', 'deliverable']) {
    try { delete require.cache[require.resolve('../../src/main/team/' + m)]; } catch (_) {}
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

test('E2E：设目标 → 多轮推进 → 达标 → 报告', () => {
  const { 'self-loop': sl, deliverable: d } = fresh(['self-loop', 'deliverable']);
  const g = sl.createGoal({ title: '完善功能', successCriteria: ['功能完整', '测试通过'], maxRounds: 5 }).goal;

  // 第1轮：未达标 → 应决定复盘
  sl.recordRound(g.id, { evidence: { criteriaResults: { '功能完整': false, '测试通过': false } }, actions: ['execute'] });
  assert.strictEqual(sl.decideNextAction(g.id).action, 'retrospect');

  // 第2轮：复盘+生成，仍未达标 → 应决定执行
  sl.recordRound(g.id, { evidence: { criteriaResults: { '功能完整': true, '测试通过': false } }, actions: ['retrospect', 'forge'] });
  assert.strictEqual(sl.decideNextAction(g.id).action, 'execute');

  // 第3轮：达标 → 停
  sl.recordRound(g.id, { evidence: { criteriaResults: { '功能完整': true, '测试通过': true } }, actions: ['execute'] });
  assert.strictEqual(sl.getGoal(g.id).status, 'achieved');
  assert.strictEqual(sl.decideNextAction(g.id).action, 'done');

  // 报告
  const report = d.buildGoalReport(g.id);
  assert.ok(report.indexOf('目标达成报告') !== -1);
  assert.ok(report.indexOf('✅') !== -1);
});

test('E2E：防呆层拦截失控目标', () => {
  const { 'self-loop': sl, 'self-loop-guard': guard } = fresh(['self-loop', 'self-loop-guard']);
  const g = sl.createGoal({ title: 'T', successCriteria: ['x'], maxRounds: 3 }).goal;
  // 连续 3 轮无提升（都0分）
  for (let i = 0; i < 3; i++) {
    sl.recordRound(g.id, { evidence: { criteriaResults: { x: false } }, actions: ['execute'] });
  }
  // 第4轮：应已达 maxRounds → exhausted
  assert.strictEqual(sl.getGoal(g.id).status, 'exhausted');
  // 防呆检查
  const h = guard.checkGoalHealth(g.id);
  assert.ok(h && typeof h.action === 'string');
});

test('E2E：完美模式（连续N轮满分才停）', () => {
  const { 'self-loop': sl } = fresh(['self-loop', 'evolution-boundary']);
  const g = sl.createGoal({ title: 'T', successCriteria: ['x'], perfect: true, maxRounds: 10 }).goal;
  // 第1轮全达标 → 继续
  let r = sl.recordRound(g.id, { evidence: { criteriaResults: { x: true } } });
  assert.strictEqual(r.goal.status, 'running');
  // 第2轮全达标 → 完美
  r = sl.recordRound(g.id, { evidence: { criteriaResults: { x: true } } });
  assert.strictEqual(r.goal.status, 'perfect');
});

test('E2E：注入风暴防护', () => {
  const { 'self-loop-guard': guard } = fresh(['self-loop-guard']);
  // 前2次可注入，第3次应被拒
  assert.strictEqual(guard.canInject('p1').allowed !== false, true);
  guard.recordInject('p1');
  guard.recordInject('p1');
  const third = guard.canInject('p1');
  assert.strictEqual(third.allowed, false);
});

test('E2E：成果交付通知判定', () => {
  const { 'self-loop': sl, deliverable: d } = fresh(['self-loop', 'deliverable']);
  const g = sl.createGoal({ title: 'T', successCriteria: ['x'] }).goal;
  sl.recordRound(g.id, { evidence: { criteriaResults: { x: true } } });
  const n = d.shouldNotify(g.id, 'achieved');
  assert.strictEqual(n.notify, true);
  assert.strictEqual(n.level, 'success');
});
