'use strict';
/**
 * self-loop-guard.js 单元测试 —— 自驱循环防呆层
 * 覆盖：死循环防护 / 成本控制 / 注入风暴防护 / 停滞检测+熔断 / 异常自愈建议
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
    if (request === 'electron') {
      return { app: { getPath: () => tmpDir } };
    }
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() { Module._load = origLoad; }

function freshGuard() {
  delete require.cache[require.resolve('../../src/main/team/self-loop')];
  delete require.cache[require.resolve('../../src/main/team/self-loop-guard')];
  const sl = require('../../src/main/team/self-loop');
  const guard = require('../../src/main/team/self-loop-guard');
  return { sl, guard };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-guard-'));
  installMock();
});
afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/team/self-loop')];
  delete require.cache[require.resolve('../../src/main/team/self-loop-guard')];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// ---------- 成本控制 ----------

test('estimateCost 返回轮次/时长/token 估算', () => {
  const { guard } = freshGuard();
  const g = { round: 3, createdAt: Date.now() - 1000 };
  const c = guard.estimateCost(g);
  assert.strictEqual(c.rounds, 3);
  assert.ok(c.elapsedMs >= 1000);
  assert.ok(c.tokens > 0);
});

test('estimateCost 空对象不抛异常', () => {
  const { guard } = freshGuard();
  const c = guard.estimateCost(null);
  assert.strictEqual(c.rounds, 0);
});

test('checkBudget 未超预算', () => {
  const { guard } = freshGuard();
  const g = { round: 2, maxRounds: 20, createdAt: Date.now() };
  const r = guard.checkBudget(g);
  assert.strictEqual(r.exceeded, false);
});

test('checkBudget 轮次超预算', () => {
  const { guard } = freshGuard();
  const g = { round: 20, maxRounds: 20, createdAt: Date.now() };
  const r = guard.checkBudget(g);
  assert.strictEqual(r.exceeded, true);
  assert.ok(/轮次/.test(r.reason));
});

test('checkBudget 时长超预算', () => {
  const { guard } = freshGuard();
  const g = { round: 1, maxRounds: 20, maxMs: 1, createdAt: Date.now() - 10000 };
  const r = guard.checkBudget(g);
  assert.strictEqual(r.exceeded, true);
  assert.ok(/时长/.test(r.reason));
});

test('checkBudget config 覆盖默认', () => {
  const { guard } = freshGuard();
  const g = { round: 5, createdAt: Date.now() };
  const r = guard.checkBudget(g, { maxRounds: 5 });
  assert.strictEqual(r.exceeded, true);
});

// ---------- 停滞检测 ----------

test('detectStagnation 得分递增 → 不停滞', () => {
  const { sl, guard } = freshGuard();
  const g = sl.createGoal({ title: 't', successCriteria: ['a', 'b', 'c', 'd'] }).goal;
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: true } }, actions: ['execute'] });
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: true, b: true } }, actions: ['retrospect', 'forge'] });
  const st = guard.detectStagnation(g.id);
  assert.strictEqual(st.stagnant, false);
});

test('detectStagnation 连续 3 轮无提升 → 停滞', () => {
  const { sl, guard } = freshGuard();
  const g = sl.createGoal({ title: 't', successCriteria: ['a', 'b'] }).goal;
  // 第一次 0.5（提升）
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: true, b: false } }, actions: ['execute'] });
  // 后三轮都 0.5（无提升）
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: true, b: false } }, actions: ['retrospect'] });
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: true, b: false } }, actions: ['forge'] });
  const r = sl.recordRound(g.id, { evidence: { criteriaResults: { a: true, b: false } }, actions: ['execute'] });
  const st = guard.detectStagnation(g.id);
  assert.strictEqual(st.consecutive >= 3, true);
  assert.strictEqual(st.stagnant, true);
});

test('detectStagnation 目标不存在 → 不抛异常', () => {
  const { guard } = freshGuard();
  const st = guard.detectStagnation('no-such-goal');
  assert.strictEqual(st.stagnant, false);
});

// ---------- 同一步骤重复 ----------

test('detectRepeatedStep 重复 3 轮 → repeated', () => {
  const { guard } = freshGuard();
  const goal = { history: [
    { actions: ['execute'], score: 0.5 },
    { actions: ['execute'], score: 0.5 },
    { actions: ['execute'], score: 0.5 },
  ] };
  const r = guard.detectRepeatedStep(goal);
  assert.strictEqual(r.repeated, true);
  assert.ok(r.count >= 3);
});

test('detectRepeatedStep 步骤不同 → 不重复', () => {
  const { guard } = freshGuard();
  const goal = { history: [
    { actions: ['execute'], score: 0.5 },
    { actions: ['retrospect'], score: 0.5 },
    { actions: ['forge'], score: 0.6 },
  ] };
  const r = guard.detectRepeatedStep(goal);
  assert.strictEqual(r.repeated, false);
});

// ---------- 注入风暴防护 ----------

test('canInject 首次允许', () => {
  const { guard } = freshGuard();
  const r = guard.canInject('p1');
  assert.strictEqual(r.allowed, true);
});

test('canInject 窗口内超过上限 → 拒绝', () => {
  const { guard } = freshGuard();
  const t = 1000000;
  guard.recordInject('p1', 'g1', t);
  guard.recordInject('p1', 'g1', t + 1000);
  const r = guard.canInject('p1', t + 2000);
  assert.strictEqual(r.allowed, false);
  assert.ok(/频率/.test(r.reason));
});

test('canInject 窗口滑出后恢复', () => {
  const { guard } = freshGuard();
  const t = 1000000;
  guard.recordInject('p1', 'g1', t);
  guard.recordInject('p1', 'g1', t + 1000);
  const r = guard.canInject('p1', t + 70000);
  assert.strictEqual(r.allowed, true);
});

test('recordInject 累计目标注入次数', () => {
  const { guard } = freshGuard();
  guard.recordInject('p1', 'g1');
  guard.recordInject('p1', 'g1');
  assert.strictEqual(guard.getInjectCount('g1'), 2);
});

// ---------- 异常追踪 ----------

test('recordFault 累加，clearFaults 清除', () => {
  const { guard } = freshGuard();
  guard.recordFault('g1', 'boom');
  guard.recordFault('g1', 'boom2');
  assert.strictEqual(guard.getFaults('g1').count, 2);
  guard.clearFaults('g1');
  assert.strictEqual(guard.getFaults('g1').count, 0);
});

// ---------- 健康度总检 ----------

test('checkGoalHealth 健康目标 → continue', () => {
  const { sl, guard } = freshGuard();
  const g = sl.createGoal({ title: 't', successCriteria: ['a', 'b'] }).goal;
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: true } }, actions: ['execute'] });
  const h = guard.checkGoalHealth(g.id);
  assert.strictEqual(h.healthy, true);
  assert.strictEqual(h.action, 'continue');
  assert.strictEqual(h.issues.length, 0);
});

test('checkGoalHealth 目标不存在 → stop', () => {
  const { guard } = freshGuard();
  const h = guard.checkGoalHealth('nope');
  assert.strictEqual(h.healthy, false);
  assert.strictEqual(h.action, 'stop');
});

test('checkGoalHealth 超预算 → stop', () => {
  const { sl, guard } = freshGuard();
  const g = sl.createGoal({ title: 't', maxRounds: 1, successCriteria: ['a'] }).goal;
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: false } } });
  // recordRound 达到 maxRounds 会把 status 设为 exhausted，这里目标仍在
  const h = guard.checkGoalHealth(g.id);
  assert.strictEqual(h.issues.length > 0, true);
  assert.ok(h.action === 'stop' || h.action === 'circuit-break');
});

test('checkGoalHealth 注入超上限 → stop', () => {
  const { sl, guard } = freshGuard();
  const g = sl.createGoal({ title: 't', successCriteria: ['a', 'b', 'c'] }).goal;
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: true } }, actions: ['execute'] });
  for (let i = 0; i < guard.MAX_INJECTS_PER_GOAL; i++) guard.recordInject('p1', g.id);
  const h = guard.checkGoalHealth(g.id);
  assert.strictEqual(h.action, 'stop');
  assert.ok(h.issues.some(function (x) { return /注入次数/.test(x); }));
});

test('checkGoalHealth 连续异常 → circuit-break', () => {
  const { sl, guard } = freshGuard();
  const g = sl.createGoal({ title: 't', successCriteria: ['a', 'b'] }).goal;
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: true } }, actions: ['execute'] });
  guard.recordFault(g.id, 'e1');
  guard.recordFault(g.id, 'e2');
  guard.recordFault(g.id, 'e3');
  const h = guard.checkGoalHealth(g.id);
  assert.strictEqual(h.action, 'circuit-break');
  assert.ok(h.issues.some(function (x) { return /异常/.test(x); }));
});

test('checkGoalHealth 停滞 → circuit-break', () => {
  const { sl, guard } = freshGuard();
  const g = sl.createGoal({ title: 't', successCriteria: ['a', 'b'] }).goal;
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: true, b: false } }, actions: ['execute'] });
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: true, b: false } }, actions: ['retrospect'] });
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: true, b: false } }, actions: ['forge'] });
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: true, b: false } }, actions: ['execute'] });
  const h = guard.checkGoalHealth(g.id);
  assert.strictEqual(h.healthy, false);
  assert.ok(h.action === 'circuit-break' || h.action === 'stop');
});

// ---------- 异常自愈建议 ----------

test('suggestRecovery 预算问题 → stop + notify', () => {
  const { guard } = freshGuard();
  const r = guard.suggestRecovery({ title: 't' }, ['轮次超预算 (20/20)']);
  assert.strictEqual(r.strategy, 'stop');
  assert.strictEqual(r.notify, true);
  assert.ok(r.actions.length > 0);
});

test('suggestRecovery 停滞 → switch-strategy', () => {
  const { guard } = freshGuard();
  const r = guard.suggestRecovery({ title: 't' }, ['连续 3 轮得分无提升']);
  assert.strictEqual(r.strategy, 'switch-strategy');
  assert.ok(r.actions.length > 0);
});

test('suggestRecovery 异常 → degrade + notify', () => {
  const { guard } = freshGuard();
  const r = guard.suggestRecovery({ title: 't' }, ['连续异常 3 次：timeout']);
  assert.strictEqual(r.strategy, 'degrade');
  assert.strictEqual(r.notify, true);
});

test('suggestRecovery 无问题 → 保持策略', () => {
  const { guard } = freshGuard();
  const r = guard.suggestRecovery({ title: 't' }, []);
  assert.strictEqual(r.strategy, 'continue');
  assert.ok(r.actions.length > 0);
});

test('suggestRecovery 空参数不抛异常', () => {
  const { guard } = freshGuard();
  const r = guard.suggestRecovery(null, null);
  assert.ok(typeof r.strategy === 'string');
});

// ---------- 综合：防呆闭环 ----------

test('综合：目标失控 → 健康检查给出熔断/停止 + 恢复建议', () => {
  const { sl, guard } = freshGuard();
  const g = sl.createGoal({ title: '无人干预目标', successCriteria: ['a', 'b'], maxRounds: 10 }).goal;
  // 模拟连续无提升 + 异常
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: true, b: false } }, actions: ['execute'] });
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: true, b: false } }, actions: ['execute'] });
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: true, b: false } }, actions: ['execute'] });
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: true, b: false } }, actions: ['execute'] });
  guard.recordFault(g.id, 'x');
  guard.recordFault(g.id, 'x');
  guard.recordFault(g.id, 'x');
  const h = guard.checkGoalHealth(g.id);
  assert.strictEqual(h.healthy, false);
  assert.ok(h.action === 'circuit-break' || h.action === 'stop');
  const rec = guard.suggestRecovery(g, h.issues);
  assert.ok(rec.actions.length > 0);
  assert.ok(rec.notify === true || rec.strategy !== 'continue');
});
