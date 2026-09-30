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
  delete require.cache[require.resolve('../../src/main/team/evolution-boundary')];
  return require('../../src/main/team/evolution-boundary');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-evo-boundary-'));
  installMock();
});
afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/team/evolution-boundary')];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// ========== checkSkillCapacity ==========

test('checkSkillCapacity：未达上限', () => {
  const eb = fresh();
  const r = eb.checkSkillCapacity({ skills: new Array(10).fill({}), limit: 100 });
  assert.strictEqual(r.count, 10);
  assert.strictEqual(r.limit, 100);
  assert.strictEqual(r.atLimit, false);
  assert.strictEqual(r.remaining, 90);
  assert.match(r.suggestion, /正常/);
});

test('checkSkillCapacity：达到上限时 atLimit 且建议淘汰', () => {
  const eb = fresh();
  const r = eb.checkSkillCapacity({ skills: new Array(100).fill({}), limit: 100 });
  assert.strictEqual(r.atLimit, true);
  assert.strictEqual(r.remaining, 0);
  assert.match(r.suggestion, /淘汰|归档/);
});

test('checkSkillCapacity：超过上限', () => {
  const eb = fresh();
  const r = eb.checkSkillCapacity({ skills: new Array(120).fill({}), limit: 100 });
  assert.strictEqual(r.atLimit, true);
  assert.strictEqual(r.remaining, 0);
});

test('checkSkillCapacity：knowledge 抛错时保守返回未达上限', () => {
  const eb = fresh();
  const brokenKnowledge = { listSkills() { throw new Error('boom'); } };
  const r = eb.checkSkillCapacity({ knowledge: brokenKnowledge });
  assert.strictEqual(r.atLimit, false);
  assert.match(r.suggestion, /无法读取/);
});

// ========== checkMetaDepth ==========

test('checkMetaDepth：版本正常', () => {
  const eb = fresh();
  const r = eb.checkMetaDepth({ version: 5, limit: 50 });
  assert.strictEqual(r.version, 5);
  assert.strictEqual(r.atLimit, false);
  assert.strictEqual(r.warning, null);
});

test('checkMetaDepth：超过上限告警', () => {
  const eb = fresh();
  const r = eb.checkMetaDepth({ version: 50, limit: 50 });
  assert.strictEqual(r.atLimit, true);
  assert.match(r.warning, /递归/);
});

test('checkMetaDepth：meta 模块抛错时保守不告警', () => {
  const eb = fresh();
  const brokenMeta = { getMetaVersion() { throw new Error('x'); } };
  const r = eb.checkMetaDepth({ meta: brokenMeta });
  assert.strictEqual(r.atLimit, false);
  assert.strictEqual(r.warning, null);
});

// ========== isPerfect ==========

test('isPerfect：全满足 + 连续 2 轮满分 + 无遗留 → 完美', () => {
  const eb = fresh();
  const goal = {
    successCriteria: ['A', 'B'],
    history: [{ score: 1 }, { score: 1 }],
  };
  const r = eb.isPerfect(goal, { criteriaResults: { A: true, B: true }, streak: 2 });
  assert.strictEqual(r.perfect, true);
  assert.match(r.reason, /已达完美/);
});

test('isPerfect：有标准未满足 → 不完美', () => {
  const eb = fresh();
  const goal = { successCriteria: ['A', 'B'], history: [{ score: 1 }, { score: 1 }] };
  const r = eb.isPerfect(goal, { criteriaResults: { A: true, B: false }, streak: 2 });
  assert.strictEqual(r.perfect, false);
  assert.match(r.reason, /未达标标准/);
});

test('isPerfect：存在未解决问题 → 不完美', () => {
  const eb = fresh();
  const goal = { successCriteria: ['A'], history: [{ score: 1 }, { score: 1 }] };
  const r = eb.isPerfect(goal, { criteriaResults: { A: true }, unresolved: ['还有 bug'], streak: 2 });
  assert.strictEqual(r.perfect, false);
  assert.match(r.reason, /未解决问题/);
});

test('isPerfect：连续满分轮数不足 → 不完美', () => {
  const eb = fresh();
  const goal = { successCriteria: ['A'], history: [{ score: 0.5 }, { score: 1 }] };
  const r = eb.isPerfect(goal, { criteriaResults: { A: true }, streak: 3 });
  assert.strictEqual(r.perfect, false);
  assert.match(r.reason, /连续满分/);
});

test('isPerfect：无显式标准时以 aiScore 判定', () => {
  const eb = fresh();
  const goal = { successCriteria: [], history: [{ score: 1 }, { score: 1 }] };
  assert.strictEqual(eb.isPerfect(goal, { aiScore: 1, streak: 2 }).perfect, true);
  assert.strictEqual(eb.isPerfect(goal, { aiScore: 0.9, streak: 2 }).perfect, false);
});

// ========== detectEvolutionStall ==========

test('detectEvolutionStall：近期有活动 → 未停滞', () => {
  const eb = fresh();
  const now = Date.now();
  const r = eb.detectEvolutionStall({
    now,
    stallDays: 14,
    stats: [{ createdAt: now - 86400000, lastUsedAt: now - 3600000 }],
    metaHistory: [],
  });
  assert.strictEqual(r.stalled, false);
  assert.ok(r.daysSince !== null);
  assert.match(r.action, /活跃/);
});

test('detectEvolutionStall：长期无活动 → 停滞并给建议', () => {
  const eb = fresh();
  const now = Date.now();
  const r = eb.detectEvolutionStall({
    now,
    stallDays: 14,
    stats: [{ createdAt: now - 30 * 86400000, lastUsedAt: now - 20 * 86400000 }],
    metaHistory: [],
  });
  assert.strictEqual(r.stalled, true);
  assert.match(r.action, /停滞/);
});

test('detectEvolutionStall：无数据时不判停滞', () => {
  const eb = fresh();
  const r = eb.detectEvolutionStall({ stats: [], metaHistory: [] });
  assert.strictEqual(r.stalled, false);
  assert.strictEqual(r.lastActivityAt, null);
});

test('detectEvolutionStall：元技能 bump 也算活动', () => {
  const eb = fresh();
  const now = Date.now();
  const recent = new Date(now - 3600000).toISOString();
  const r = eb.detectEvolutionStall({
    now,
    stallDays: 14,
    stats: [],
    metaHistory: [{ from: 1, to: 2, at: recent }],
  });
  assert.strictEqual(r.stalled, false);
});

// ========== getCapacityReport ==========

test('getCapacityReport：健康度 ok', () => {
  const eb = fresh();
  const r = eb.getCapacityReport({
    skills: new Array(5).fill({}),
    version: 3,
    trace: { listTraces: () => [] },
  });
  assert.strictEqual(r.skills.count, 5);
  assert.strictEqual(r.meta.version, 3);
  assert.strictEqual(r.health, 'ok');
});

test('getCapacityReport：超限时 health=over', () => {
  const eb = fresh();
  const r = eb.getCapacityReport({
    skills: new Array(100).fill({}),
    version: 50,
    trace: { listTraces: () => [] },
  });
  assert.strictEqual(r.health, 'over');
});

test('getCapacityReport：接近上限 warn', () => {
  const eb = fresh();
  const r = eb.getCapacityReport({
    skills: new Array(85).fill({}),
    version: 3,
    trace: { listTraces: () => [] },
  });
  assert.strictEqual(r.health, 'warn');
});

test('getCapacityReport：trace 模块缺失也能返回', () => {
  const eb = fresh();
  const r = eb.getCapacityReport({
    skills: [],
    version: 1,
    trace: { /* 无 listTraces */ },
  });
  assert.strictEqual(r.traces.count, 0);
  assert.ok(r.generatedAt);
});
