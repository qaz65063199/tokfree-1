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
  delete require.cache[require.resolve('../../src/main/team/auto-evolve')];
  delete require.cache[require.resolve('../../src/main/team/trace')];
  delete require.cache[require.resolve('../../src/main/team/retrospect')];
  delete require.cache[require.resolve('../../src/main/team/skill-evolver')];
  return require('../../src/main/team/auto-evolve');
}

function freshTrace() {
  return require('../../src/main/team/trace');
}

/** 自进化飞轮总开关默认关；测试 scheduler 前需先打开 */
function enableEvolution() {
  require('../../src/main/team/evolution-switch').setEnabled(true);
}

/** 写 skill-stats.json，用于驱动 skill-evolver.analyze */
function writeStats(stats) {
  const kdir = path.join(tmpDir, 'knowledge');
  if (!fs.existsSync(kdir)) fs.mkdirSync(kdir, { recursive: true });
  fs.writeFileSync(path.join(kdir, 'skill-stats.json'), JSON.stringify({ stats: stats }), 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-autoevolve-'));
  installMock();
  // 自进化飞轮总开关默认关 → 每个用例重置到"干净且关闭"状态
  const sw = require('../../src/main/team/evolution-switch');
  sw._reset();
  sw._setConfigFile(path.join(tmpDir, 'evolution-config.json'));
});
afterEach(() => {
  uninstallMock();
  ['auto-evolve', 'trace', 'retrospect', 'skill-evolver'].forEach((m) => {
    try { delete require.cache[require.resolve('../../src/main/team/' + m)]; } catch (_) {}
  });
  try { require('../../src/main/team/evolution-switch')._reset(); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// ---------- summarizeTrace ----------

test('summarizeTrace 从完整 trace 现场统计', () => {
  const ae = fresh();
  const t = {
    startedAt: new Date(Date.now() - 5000).toISOString(),
    endedAt: new Date().toISOString(),
    steps: [
      { success: true, durationMs: 10 },
      { success: false, durationMs: 20 },
      { success: true, durationMs: 30 },
    ],
  };
  const m = ae.summarizeTrace(t);
  assert.strictEqual(m.stepCount, 3);
  assert.strictEqual(m.errorCount, 1);
  assert.ok(m.durationMs >= 4000); // 墙钟约 5000ms
});

test('summarizeTrace 兼容摘要形态', () => {
  const ae = fresh();
  const m = ae.summarizeTrace({ errorCount: 2, durationMs: 1234, stepCount: 5 });
  assert.strictEqual(m.errorCount, 2);
  assert.strictEqual(m.durationMs, 1234);
  assert.strictEqual(m.stepCount, 5);
});

test('summarizeTrace 空输入安全', () => {
  const ae = fresh();
  const m = ae.summarizeTrace(null);
  assert.deepStrictEqual(m, { errorCount: 0, durationMs: 0, stepCount: 0 });
});

// ---------- shouldAutoRetrospect ----------

test('有失败步骤 → 值得复盘', () => {
  const ae = fresh();
  assert.strictEqual(ae.shouldAutoRetrospect({ errorCount: 1, durationMs: 0, stepCount: 1 }), true);
});

test('耗时长 → 值得复盘', () => {
  const ae = fresh();
  assert.strictEqual(ae.shouldAutoRetrospect({ errorCount: 0, durationMs: 120000, stepCount: 3 }), true);
});

test('步骤多 → 值得复盘', () => {
  const ae = fresh();
  assert.strictEqual(ae.shouldAutoRetrospect({ errorCount: 0, durationMs: 0, stepCount: 50 }), true);
});

test('平稳轨迹 → 不值得复盘', () => {
  const ae = fresh();
  assert.strictEqual(ae.shouldAutoRetrospect({ errorCount: 0, durationMs: 1000, stepCount: 3 }), false);
});

test('阈值可覆盖', () => {
  const ae = fresh();
  assert.strictEqual(ae.shouldAutoRetrospect({ errorCount: 1, durationMs: 0, stepCount: 1 }, { errorThreshold: 2 }), false);
});

test('空输入安全返回 false', () => {
  const ae = fresh();
  assert.strictEqual(ae.shouldAutoRetrospect(null), false);
});

// ---------- triggerRetrospect ----------

test('triggerRetrospect 平稳轨迹不生成分析', () => {
  const ae = fresh();
  const tr = freshTrace();
  tr.beginTrace('t-smooth', {});
  tr.recordStep('t-smooth', { tool: 'read', success: true, durationMs: 5 });
  tr.endTrace('t-smooth', {});
  const res = ae.triggerRetrospect('t-smooth');
  assert.strictEqual(res.shouldRetrospect, false);
  assert.strictEqual(res.analysis, null);
});

test('triggerRetrospect 有失败步骤 → 生成分析', () => {
  const ae = fresh();
  const tr = freshTrace();
  tr.beginTrace('t-fail', {});
  tr.recordStep('t-fail', { tool: 'read', success: true, durationMs: 5 });
  tr.recordStep('t-fail', { tool: 'write', success: false, error: '权限拒绝', durationMs: 5 });
  tr.endTrace('t-fail', {});
  const res = ae.triggerRetrospect('t-fail');
  assert.strictEqual(res.shouldRetrospect, true);
  assert.ok(res.analysis);
  assert.strictEqual(res.analysis.ok, true);
  assert.ok(res.analysis.failureModes.length >= 1);
});

test('triggerRetrospect 轨迹不存在安全返回', () => {
  const ae = fresh();
  const res = ae.triggerRetrospect('not-exist');
  assert.strictEqual(res.shouldRetrospect, false);
  assert.strictEqual(res.analysis, null);
});

test('triggerRetrospect 缺 taskId 安全返回', () => {
  const ae = fresh();
  const res = ae.triggerRetrospect('');
  assert.strictEqual(res.shouldRetrospect, false);
});

// ---------- buildAdvice ----------

test('buildAdvice 低成功率 → 建议改写 description', () => {
  const ae = fresh();
  const adv = ae.buildAdvice({ rate: 0.3, avgMs: 100, uses: 5 });
  assert.ok(adv.some((s) => s.includes('description')));
});

test('buildAdvice 耗时长 → 建议简化', () => {
  const ae = fresh();
  const adv = ae.buildAdvice({ rate: 0.9, avgMs: 99999, uses: 5 });
  assert.ok(adv.some((s) => s.includes('简化')));
});

// ---------- runOptimizePass ----------

test('runOptimizePass 为空技能库返回空建议', () => {
  const ae = fresh();
  const res = ae.runOptimizePass();
  assert.strictEqual(res.total, 0);
  assert.deepStrictEqual(res.suggestions, []);
});

test('runOptimizePass 对低成功率技能生成建议', () => {
  const ae = fresh();
  writeStats({
    bad: { uses: 5, success: 1, fail: 4, totalMs: 0, lastUsedAt: Date.now(), createdAt: Date.now(), archived: false },
  });
  const res = ae.runOptimizePass();
  assert.ok(res.total >= 1);
  const s = res.suggestions.find((x) => x.name === 'bad');
  assert.ok(s);
  assert.ok(s.advice.length >= 1);
  assert.ok(s.advice.some((a) => a.includes('成功率')));
});

test('runOptimizePass 对耗时长技能生成建议', () => {
  const ae = fresh();
  writeStats({
    slow: { uses: 4, success: 4, fail: 0, totalMs: 4 * 50000, lastUsedAt: Date.now(), createdAt: Date.now(), archived: false },
  });
  const res = ae.runOptimizePass();
  const s = res.suggestions.find((x) => x.name === 'slow');
  assert.ok(s);
  assert.ok(s.advice.some((a) => a.includes('简化')));
});

// ---------- runDailyMaintenance ----------

test('runDailyMaintenance 汇总淘汰与优化', () => {
  const ae = fresh();
  writeStats({
    bad: { uses: 5, success: 1, fail: 4, totalMs: 0, lastUsedAt: Date.now(), createdAt: Date.now(), archived: false },
  });
  const res = ae.runDailyMaintenance();
  assert.ok(res.ranAt);
  assert.ok(typeof res.archived === 'number');
  assert.ok(res.archive);
  assert.ok(res.optimize);
  assert.ok(res.optimizeCount >= 1);
});

test('runDailyMaintenance 空库安全', () => {
  const ae = fresh();
  const res = ae.runDailyMaintenance();
  assert.strictEqual(res.archived, 0);
  assert.strictEqual(res.optimizeCount, 0);
});

// ---------- 定时器 ----------

test('startScheduler / stopScheduler 生命周期', () => {
  enableEvolution();
  const ae = fresh();
  assert.strictEqual(ae.isSchedulerRunning(), false);
  const s = ae.startScheduler({ intervalMs: 100000 });
  assert.strictEqual(s.started, true);
  assert.strictEqual(ae.isSchedulerRunning(), true);
  // 重复启动被拒
  const s2 = ae.startScheduler({ intervalMs: 100000 });
  assert.strictEqual(s2.started, false);
  ae.stopScheduler();
  assert.strictEqual(ae.isSchedulerRunning(), false);
});

test('startScheduler 定时触发 run 回调', async () => {
  enableEvolution();
  const ae = fresh();
  let called = 0;
  ae.startScheduler({ intervalMs: 20, run: () => { called++; } });
  await new Promise((r) => setTimeout(r, 90));
  ae.stopScheduler();
  assert.ok(called >= 1);
});
