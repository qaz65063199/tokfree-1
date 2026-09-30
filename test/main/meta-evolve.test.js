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

function freshMeta() {
  delete require.cache[require.resolve('../../src/main/team/meta-evolve')];
  return require('../../src/main/team/meta-evolve');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-meta-'));
  installMock();
});
afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/team/meta-evolve')];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

test('recordMetaOutcome：记录并持久化', () => {
  const meta = freshMeta();
  const r = meta.recordMetaOutcome({ activity: 'retrospect', taskId: 't1', success: true, usefulScore: 0.8 });
  assert.strictEqual(r.ok, true);
  assert.ok(r.id);
  const stats = meta.getMetaStats();
  assert.strictEqual(stats.outcomes.length, 1);
  assert.strictEqual(stats.outcomes[0].activity, 'retrospect');
  assert.strictEqual(stats.outcomes[0].usefulScore, 0.8);
});

test('recordMetaOutcome：usefulScore 会被 clamp 到 0-1', () => {
  const meta = freshMeta();
  meta.recordMetaOutcome({ activity: 'forge', success: true, usefulScore: 5 });
  meta.recordMetaOutcome({ activity: 'forge', success: true, usefulScore: -3 });
  const stats = meta.getMetaStats();
  assert.strictEqual(stats.outcomes[0].usefulScore, 1);
  assert.strictEqual(stats.outcomes[1].usefulScore, 0);
});

test('recordMetaOutcome：activity 为空则拒绝', () => {
  const meta = freshMeta();
  const r = meta.recordMetaOutcome({ success: true });
  assert.strictEqual(r.ok, false);
});

test('recordMetaOutcome：容错（不抛异常）', () => {
  const meta = freshMeta();
  assert.doesNotThrow(() => meta.recordMetaOutcome(null));
  const r = meta.recordMetaOutcome(undefined);
  assert.strictEqual(r.ok, false);
});

test('analyzeMeta：空统计返回 ok', () => {
  const meta = freshMeta();
  const a = meta.analyzeMeta();
  assert.strictEqual(a.ok, true);
  assert.deepStrictEqual(a.activities, {});
  assert.deepStrictEqual(a.insights, []);
});

test('analyzeMeta：forge 通过率低 → warn 洞察', () => {
  const meta = freshMeta();
  meta.recordMetaOutcome({ activity: 'forge', success: false });
  meta.recordMetaOutcome({ activity: 'forge', success: false });
  meta.recordMetaOutcome({ activity: 'forge', success: true });
  const a = meta.analyzeMeta();
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.activities.forge.total, 3);
  assert.ok(a.activities.forge.successRate < 0.7);
  assert.ok(a.insights.some(i => i.activity === 'forge' && i.level === 'warn'));
});

test('analyzeMeta：retrospect 采纳率高 → ok 洞察', () => {
  const meta = freshMeta();
  meta.recordMetaOutcome({ activity: 'retrospect', success: true, usefulScore: 0.9 });
  meta.recordMetaOutcome({ activity: 'retrospect', success: true, usefulScore: 0.85 });
  const a = meta.analyzeMeta();
  assert.ok(a.activities.retrospect.avgUsefulScore > 0.6);
  assert.ok(a.insights.some(i => i.activity === 'retrospect' && i.level === 'ok'));
});

test('analyzeMeta：retrospect 采纳率低 → warn 洞察', () => {
  const meta = freshMeta();
  meta.recordMetaOutcome({ activity: 'retrospect', success: true, usefulScore: 0.2 });
  meta.recordMetaOutcome({ activity: 'retrospect', success: true, usefulScore: 0.3 });
  const a = meta.analyzeMeta();
  assert.ok(a.insights.some(i => i.activity === 'retrospect' && i.level === 'warn'));
});

test('suggestMetaImprovement：为 warn 洞察生成建议', () => {
  const meta = freshMeta();
  meta.recordMetaOutcome({ activity: 'forge', success: false });
  meta.recordMetaOutcome({ activity: 'forge', success: false });
  const r = meta.suggestMetaImprovement();
  assert.strictEqual(r.ok, true);
  assert.ok(r.suggestions.length >= 1);
  const s = r.suggestions[0];
  assert.strictEqual(s.activity, 'forge');
  assert.ok(s.target);
  assert.ok(s.action);
  assert.ok(s.reason);
});

test('suggestMetaImprovement：无警告时返回空建议', () => {
  const meta = freshMeta();
  meta.recordMetaOutcome({ activity: 'forge', success: true });
  meta.recordMetaOutcome({ activity: 'forge', success: true });
  const r = meta.suggestMetaImprovement();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.suggestions.length, 0);
});

test('getMetaVersion：默认返回 v1 与方法描述', () => {
  const meta = freshMeta();
  const v = meta.getMetaVersion();
  assert.strictEqual(v.version, 1);
  assert.ok(v.methods.retrospect);
  assert.ok(v.methods.forge);
  assert.ok(v.methods.optimize);
});

test('bumpMetaVersion：版本递增并记录历史', () => {
  const meta = freshMeta();
  const r1 = meta.bumpMetaVersion('调整复盘 Prompt');
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.version, 2);
  const v = meta.getMetaVersion();
  assert.strictEqual(v.version, 2);
  assert.strictEqual(v.reason, '调整复盘 Prompt');
  const h = meta.getMetaHistory();
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].from, 1);
  assert.strictEqual(h[0].to, 2);
});

test('bumpMetaVersion：patchMethods 可覆盖方法描述', () => {
  const meta = freshMeta();
  meta.bumpMetaVersion('放宽阈值', { forge: '新的生成方法描述' });
  const v = meta.getMetaVersion();
  assert.strictEqual(v.methods.forge, '新的生成方法描述');
  // 未覆盖的保持原值
  assert.strictEqual(v.methods.retrospect, meta.DEFAULT_METHODS.retrospect);
});

test('bumpMetaVersion：多次递增', () => {
  const meta = freshMeta();
  meta.bumpMetaVersion('r1');
  meta.bumpMetaVersion('r2');
  meta.bumpMetaVersion('r3');
  const v = meta.getMetaVersion();
  assert.strictEqual(v.version, 4);
  const h = meta.getMetaHistory();
  assert.strictEqual(h.length, 3);
});

test('持久化：重新加载模块后数据仍在', () => {
  const meta1 = freshMeta();
  meta1.recordMetaOutcome({ activity: 'optimize', success: true });
  meta1.bumpMetaVersion('持久化测试');

  const meta2 = freshMeta();
  const stats = meta2.getMetaStats();
  assert.strictEqual(stats.outcomes.length, 1);
  assert.strictEqual(meta2.getMetaVersion().version, 2);
});

test('MAX_OUTCOMES 常量导出', () => {
  const meta = freshMeta();
  assert.strictEqual(typeof meta.MAX_OUTCOMES, 'number');
  assert.ok(meta.MAX_OUTCOMES > 0);
});

test('容错：损坏的 meta-stats.json 不抛异常', () => {
  const meta = freshMeta();
  const f = path.join(tmpDir, 'knowledge', 'meta-stats.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{ invalid json', 'utf-8');
  assert.doesNotThrow(() => meta.getMetaStats());
  const stats = meta.getMetaStats();
  assert.deepStrictEqual(stats.outcomes, []);
});

test('容错：损坏的 meta-skills.json 回退默认', () => {
  const meta = freshMeta();
  const f = path.join(tmpDir, 'knowledge', 'meta-skills.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'not json at all', 'utf-8');
  const v = meta.getMetaVersion();
  assert.strictEqual(v.version, 1);
});
