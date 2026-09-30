'use strict';
/**
 * self-loop.js 单元测试 —— 自驱循环核心（目标/达标判定/自出题/下一轮决策）
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

function fresh() {
  delete require.cache[require.resolve('../../src/main/team/self-loop')];
  return require('../../src/main/team/self-loop');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-loop-'));
  installMock();
});
afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/team/self-loop')];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

test('createGoal 建立目标', () => {
  const sl = fresh();
  const r = sl.createGoal({ title: '让测试通过', successCriteria: ['npm test 全绿', '无 lint 错误'] });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.goal.status, 'running');
  assert.strictEqual(r.goal.round, 0);
  assert.strictEqual(r.goal.successCriteria.length, 2);
});

test('createGoal 缺 title 报错', () => {
  const sl = fresh();
  assert.strictEqual(sl.createGoal({}).success, false);
});

test('evaluateGoal 全部标准达标 → achieved', () => {
  const sl = fresh();
  const g = sl.createGoal({ title: 't', successCriteria: ['a', 'b'] }).goal;
  const ev = sl.evaluateGoal(g, { criteriaResults: { a: true, b: true } });
  assert.strictEqual(ev.achieved, true);
  assert.strictEqual(ev.score, 1);
});

test('evaluateGoal 部分达标 → 未达成', () => {
  const sl = fresh();
  const g = sl.createGoal({ title: 't', successCriteria: ['a', 'b'] }).goal;
  const ev = sl.evaluateGoal(g, { criteriaResults: { a: true, b: false } });
  assert.strictEqual(ev.achieved, false);
  assert.strictEqual(ev.score, 0.5);
});

test('recordRound 未达标 → 状态仍 running', () => {
  const sl = fresh();
  const g = sl.createGoal({ title: 't', successCriteria: ['a'] }).goal;
  const r = sl.recordRound(g.id, { evidence: { criteriaResults: { a: false } }, actions: ['execute'] });
  assert.strictEqual(r.goal.status, 'running');
  assert.strictEqual(r.goal.round, 1);
});

test('recordRound 达标 → 状态 achieved，循环停止', () => {
  const sl = fresh();
  const g = sl.createGoal({ title: 't', successCriteria: ['a'] }).goal;
  const r = sl.recordRound(g.id, { evidence: { criteriaResults: { a: true } } });
  assert.strictEqual(r.goal.status, 'achieved');
  assert.strictEqual(r.evaluation.achieved, true);
});

test('recordRound 达到 maxRounds → exhausted', () => {
  const sl = fresh();
  const g = sl.createGoal({ title: 't', successCriteria: ['a'], maxRounds: 2 }).goal;
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: false } } });
  const r = sl.recordRound(g.id, { evidence: { criteriaResults: { a: false } } });
  assert.strictEqual(r.goal.status, 'exhausted');
});

test('decideNextAction 第一轮 → execute', () => {
  const sl = fresh();
  const g = sl.createGoal({ title: 't' }).goal;
  assert.strictEqual(sl.decideNextAction(g.id).action, 'execute');
});

test('decideNextAction 未达标未复盘 → retrospect', () => {
  const sl = fresh();
  const g = sl.createGoal({ title: 't', successCriteria: ['a'] }).goal;
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: false } }, actions: [] });
  assert.strictEqual(sl.decideNextAction(g.id).action, 'retrospect');
});

test('decideNextAction 已复盘未生成 → forge', () => {
  const sl = fresh();
  const g = sl.createGoal({ title: 't', successCriteria: ['a'] }).goal;
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: false } }, actions: ['retrospect'] });
  assert.strictEqual(sl.decideNextAction(g.id).action, 'forge');
});

test('decideNextAction 复盘+生成后 → 再 execute', () => {
  const sl = fresh();
  const g = sl.createGoal({ title: 't', successCriteria: ['a'] }).goal;
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: false } }, actions: ['retrospect', 'forge'] });
  assert.strictEqual(sl.decideNextAction(g.id).action, 'execute');
});

test('decideNextAction 达标 → done', () => {
  const sl = fresh();
  const g = sl.createGoal({ title: 't', successCriteria: ['a'] }).goal;
  sl.recordRound(g.id, { evidence: { criteriaResults: { a: true } } });
  assert.strictEqual(sl.decideNextAction(g.id).action, 'done');
});

test('generateTestCase 从失败发现生成测试', () => {
  const sl = fresh();
  const tc = sl.generateTestCase({ type: 'failure', title: 'write 失败', detail: '权限拒绝' });
  assert.ok(tc.question.indexOf('失败') !== -1);
  assert.ok(tc.expect);
  assert.ok(tc.how);
});

test('generateTestQueries 生成正负例', () => {
  const sl = fresh();
  const q = sl.generateTestQueries({ name: 'code-review', description: '审查代码质量' });
  assert.ok(Array.isArray(q.positive) && q.positive.length > 0);
  assert.ok(Array.isArray(q.negative) && q.negative.length > 0);
});

test('listRunningGoals 只返回运行中', () => {
  const sl = fresh();
  sl.createGoal({ title: 'g1' });
  const g2 = sl.createGoal({ title: 'g2', successCriteria: ['a'] }).goal;
  sl.recordRound(g2.id, { evidence: { criteriaResults: { a: true } } });
  assert.strictEqual(sl.listRunningGoals().length, 1);
});

test('listGoals 支持按 profileId 过滤：只含本窗口 + 无归属目标', () => {
  const sl = fresh();
  sl.createGoal({ title: 'A目标', profileId: 'winA' });
  sl.createGoal({ title: 'B目标', profileId: 'winB' });
  sl.createGoal({ title: '全局目标', profileId: '' });
  const forA = sl.listGoals({ profileId: 'winA' });
  const titles = forA.map((g) => g.title).sort();
  assert.deepStrictEqual(titles, ['A目标', '全局目标'].sort());
  assert.ok(!titles.includes('B目标'), '不能含其他窗口目标');
  // 不传 profileId → 不过滤（向后兼容）
  assert.strictEqual(sl.listGoals().length, 3);
});

test('listGoals 同时支持 status + profileId 过滤', () => {
  const sl = fresh();
  const gA = sl.createGoal({ title: 'A', profileId: 'winA', successCriteria: ['x'] }).goal;
  sl.recordRound(gA.id, { evidence: { criteriaResults: { x: true } } }); // achieved
  sl.createGoal({ title: 'A2', profileId: 'winA' });
  sl.createGoal({ title: 'B', profileId: 'winB' });
  const r = sl.listGoals({ status: 'running', profileId: 'winA' });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].title, 'A2');
});

test('createGoal 带 projectDir → 持久化正确', () => {
  const sl = fresh();
  const g = sl.createGoal({ title: 'P1目标', projectDir: 'C:/proj/one' }).goal;
  assert.strictEqual(g.projectDir, 'C:/proj/one');
  // 重新 load 验证持久化
  const reloaded = sl.getGoal(g.id);
  assert.strictEqual(reloaded.projectDir, 'C:/proj/one');
});

test('createGoal 不带 projectDir → 默认空串（无归属）', () => {
  const sl = fresh();
  const g = sl.createGoal({ title: '全局' }).goal;
  assert.strictEqual(g.projectDir, '');
});

test('listGoals({projectDir}) 严格过滤：只返回本项目（无归属不再返回）', () => {
  const sl = fresh();
  sl.createGoal({ title: 'P1目标', projectDir: 'C:/proj/one' });
  sl.createGoal({ title: 'P2目标', projectDir: 'C:/proj/two' });
  sl.createGoal({ title: '无归属目标', projectDir: '' });
  const forP1 = sl.listGoals({ projectDir: 'C:/proj/one' });
  const titles = forP1.map((g) => g.title).sort();
  assert.deepStrictEqual(titles, ['P1目标']);
  assert.ok(!titles.includes('P2目标'), '不能含其他项目目标');
  assert.ok(!titles.includes('无归属目标'), '无归属数据不再被当作本项目目标');
  // 不传 projectDir → 不过滤（向后兼容）
  assert.strictEqual(sl.listGoals().length, 3);
});

test('listGoals 支持 projectDir + status + profileId 组合过滤', () => {
  const sl = fresh();
  sl.createGoal({ title: 'A运行', projectDir: 'C:/p1', profileId: 'winA' });
  const doneG = sl.createGoal({ title: 'A已达成', projectDir: 'C:/p1', profileId: 'winA', successCriteria: ['x'] }).goal;
  sl.recordRound(doneG.id, { evidence: { criteriaResults: { x: true } } }); // achieved
  sl.createGoal({ title: '其他项目', projectDir: 'C:/p2', profileId: 'winA' });
  const r = sl.listGoals({ status: 'running', projectDir: 'C:/p1', profileId: 'winA' });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].title, 'A运行');
});

test('listRunningGoals(projectDir) 严格过滤：只含本项目（无归属不再返回）', () => {
  const sl = fresh();
  sl.createGoal({ title: 'P1运行', projectDir: 'C:/p1' });
  sl.createGoal({ title: 'P2运行', projectDir: 'C:/p2' });
  sl.createGoal({ title: '无归属运行', projectDir: '' });
  const r = sl.listRunningGoals('C:/p1');
  const titles = r.map((g) => g.title).sort();
  assert.deepStrictEqual(titles, ['P1运行']);
  // 不传参数 → 全部 running（向后兼容）
  assert.strictEqual(sl.listRunningGoals().length, 3);
});

test('老数据兼容：无 projectDir 字段的 goal 不再被当作本项目目标（严格过滤）', () => {
  const sl = fresh();
  sl._reset();
  // 直接注入一条无 projectDir 字段的老数据
  const db = { goals: [{ id: 'old-1', title: '老目标', status: 'running', round: 0, createdAt: Date.now(), updatedAt: Date.now(), successCriteria: [], profileId: '' }] };
  const fsx = require('fs');
  const pathx = require('path');
  const f = pathx.join(tmpDir, 'self-loop', 'goals.json');
  fsx.writeFileSync(f, JSON.stringify(db), 'utf-8');
  delete require.cache[require.resolve('../../src/main/team/self-loop')];
  const sl2 = require('../../src/main/team/self-loop');
  const forP1 = sl2.listGoals({ projectDir: 'C:/p1' });
  assert.strictEqual(forP1.length, 0, '无归属老数据不应再被列入本项目简报');
  assert.strictEqual(sl2.listRunningGoals('C:/p1').length, 0);
});

test('migrateLegacyGoals 幂等：标记 legacy + 补空 projectDir，不丢数据', () => {
  const sl = fresh();
  sl._reset();
  const db = { goals: [
    { id: 'old-1', title: '老目标1', status: 'achieved', round: 0, createdAt: 1, updatedAt: 1, successCriteria: [], profileId: '' },
    { id: 'new-1', title: '新目标', status: 'running', round: 0, createdAt: 2, updatedAt: 2, successCriteria: [], profileId: '', projectDir: 'C:/p1' },
  ] };
  const fsx = require('fs');
  const pathx = require('path');
  const f = pathx.join(tmpDir, 'self-loop', 'goals.json');
  fsx.writeFileSync(f, JSON.stringify(db), 'utf-8');
  delete require.cache[require.resolve('../../src/main/team/self-loop')];
  const sl2 = require('../../src/main/team/self-loop');
  // 首次迁移：1 条老数据被标记
  const r1 = sl2.migrateLegacyGoals();
  assert.strictEqual(r1.migrated, 1);
  assert.strictEqual(r1.total, 2);
  assert.strictEqual(r1.legacyTotal, 1);
  const saved = JSON.parse(fsx.readFileSync(f, 'utf-8'));
  const oldG = saved.goals.find((g) => g.id === 'old-1');
  assert.strictEqual(oldG.legacy, true);
  assert.strictEqual(oldG.projectDir, '');
  assert.strictEqual(oldG.title, '老目标1', '数据不丢');
  // 新数据未被改动
  const newG = saved.goals.find((g) => g.id === 'new-1');
  assert.notStrictEqual(newG.legacy, true);
  assert.strictEqual(newG.projectDir, 'C:/p1');
  // 二次迁移幂等：migrated=0
  const r2 = sl2.migrateLegacyGoals();
  assert.strictEqual(r2.migrated, 0);
  assert.strictEqual(r2.legacyTotal, 1);
  // legacy 目标不再出现在本项目简报
  assert.strictEqual(sl2.listGoals({ projectDir: 'C:/p1' }).length, 1);
});

test('migrateLegacyGoals 保留 global:true 的老全局目标能力', () => {
  const sl = fresh();
  const g = sl.createGoal({ title: '显式全局', projectDir: 'C:/p1' }).goal;
  sl._reset();
  const db = { goals: [{ id: g.id, title: '显式全局', status: 'achieved', projectDir: '', global: true, createdAt: 1, updatedAt: 1, successCriteria: [], profileId: '' }] };
  const fsx = require('fs');
  const pathx = require('path');
  const f = pathx.join(tmpDir, 'self-loop', 'goals.json');
  fsx.writeFileSync(f, JSON.stringify(db), 'utf-8');
  delete require.cache[require.resolve('../../src/main/team/self-loop')];
  const sl2 = require('../../src/main/team/self-loop');
  // 有 projectDir 字段（空串）→ 不视为老数据
  const r = sl2.migrateLegacyGoals();
  assert.strictEqual(r.migrated, 0);
  // global:true 例外：在任意项目下都返回
  const forOther = sl2.listGoals({ projectDir: 'C:/whatever' });
  assert.strictEqual(forOther.length, 1);
  assert.strictEqual(forOther[0].title, '显式全局');
});

test('abortGoal 中止', () => {
  const sl = fresh();
  const g = sl.createGoal({ title: 't' }).goal;
  const r = sl.abortGoal(g.id, '用户喊停');
  assert.strictEqual(r.goal.status, 'aborted');
});

test('完整自驱循环：3 轮后达标', () => {
  const sl = fresh();
  const g = sl.createGoal({ title: '让功能完善', successCriteria: ['功能完整', '测试通过'], maxRounds: 5 }).goal;
  // 第1轮：执行未达标
  sl.recordRound(g.id, { evidence: { criteriaResults: { '功能完整': false, '测试通过': false } }, actions: ['execute'] });
  assert.strictEqual(sl.decideNextAction(g.id).action, 'retrospect');
  // 第2轮：复盘+生成，仍未达标
  sl.recordRound(g.id, { evidence: { criteriaResults: { '功能完整': true, '测试通过': false } }, actions: ['retrospect', 'forge'] });
  assert.strictEqual(sl.decideNextAction(g.id).action, 'execute');
  // 第3轮：达标
  const r = sl.recordRound(g.id, { evidence: { criteriaResults: { '功能完整': true, '测试通过': true } }, actions: ['execute'] });
  assert.strictEqual(r.goal.status, 'achieved');
  assert.strictEqual(sl.decideNextAction(g.id).action, 'done');
});
