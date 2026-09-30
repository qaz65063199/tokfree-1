'use strict';
/**
 * 自工程化端到端验证（self-engineering-e2e）
 *
 * 验证「执行 → 复盘 → 生成技能 → 记录使用 → 迭代分析」闭环成立：
 *   1. trace.beginTrace + recordStep（含失败步骤）→ endTrace
 *   2. retrospect.analyzeTrace → 识别失败/优化点
 *   3. skill-forge.buildSkillDraft → validateSkill → forgeSkill 入库
 *   4. skill-evolver.recordUsage 记录若干次（含失败）→ analyze 识别
 *   5. 验证：技能库有该技能、统计正确、分析正确
 *
 * 参照 test/main/trace.test.js 用 Module._load mock electron（app.getPath → 临时目录）。
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

/** 重新加载全部自工程化模块（都走 mock 的 electron） */
function freshModules() {
  for (const m of [
    '../../src/main/team/trace',
    '../../src/main/team/retrospect',
    '../../src/main/team/skill-forge',
    '../../src/main/team/skill-evolver',
    '../../src/main/knowledge',
  ]) {
    delete require.cache[require.resolve(m)];
  }
  const trace = require('../../src/main/team/trace');
  const retrospect = require('../../src/main/team/retrospect');
  const forge = require('../../src/main/team/skill-forge');
  const evolver = require('../../src/main/team/skill-evolver');
  const knowledge = require('../../src/main/knowledge');
  return { trace, retrospect, forge, evolver, knowledge };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-selfeng-'));
  installMock();
});

afterEach(() => {
  uninstallMock();
  for (const m of [
    '../../src/main/team/trace',
    '../../src/main/team/retrospect',
    '../../src/main/team/skill-forge',
    '../../src/main/team/skill-evolver',
    '../../src/main/knowledge',
  ]) {
    delete require.cache[require.resolve(m)];
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// ========== 闭环主体 ==========

test('端到端闭环：执行→复盘→生成技能→记录使用→迭代分析', () => {
  const { trace, retrospect, forge, evolver, knowledge } = freshModules();

  // ---- 1. 造一条含失败步骤的轨迹 ----
  trace.beginTrace('e2e-1', { profileId: 'p-e2e', goal: 'Extract PDF text' });
  trace.recordStep('e2e-1', { tool: 'read', args: { file: 'a.pdf' }, success: true, durationMs: 10 });
  trace.recordStep('e2e-1', { tool: 'bash', args: { cmd: 'pdf-extract' }, success: false, error: 'ENOENT: pdf-extract not found', durationMs: 5 });
  trace.recordStep('e2e-1', { tool: 'bash', args: { cmd: 'pdf-extract' }, success: false, error: 'ENOENT: pdf-extract not found', durationMs: 5 });
  trace.recordStep('e2e-1', { tool: 'write', args: { file: 'out.txt' }, success: true, durationMs: 20 });
  trace.endTrace('e2e-1', {});

  const tr = trace.getTrace('e2e-1');
  assert.ok(tr, '轨迹应存在');
  assert.strictEqual(tr.steps.length, 4);
  assert.strictEqual(tr.outcome, 'partial', '含失败步骤 → partial');

  // ---- 2. 复盘分析：应识别失败与优化点 ----
  const analysis = retrospect.analyzeTrace('e2e-1');
  assert.strictEqual(analysis.ok, true, '分析应成功');
  assert.strictEqual(analysis.summary.stepCount, 4);
  assert.strictEqual(analysis.summary.successCount, 2);
  assert.strictEqual(analysis.summary.failCount, 2);
  assert.ok(analysis.failureModes.length >= 1, '应识别失败模式');
  assert.strictEqual(analysis.failureModes[0].tool, 'bash');
  assert.match(analysis.failureModes[0].error, /ENOENT/);
  assert.ok(analysis.findings.length >= 1, '应产出可优化点（findings）');
  assert.ok(analysis.findings.some((f) => f.type === 'failure'), 'findings 应含 failure 类型');
  // 重复调用应被识别为 retry
  assert.ok(analysis.retries.some((r) => r.tool === 'bash' && r.count >= 2), '重复 bash 调用应被识别');

  // 复盘 Prompt 非空且含关键结构
  const prompt = retrospect.buildRetrospectPrompt('e2e-1');
  assert.match(prompt, /任务复盘请求/);
  assert.match(prompt, /三个可优化点/);

  // ---- 3. 从分析生成技能草稿 → 验证 → 入库 ----
  const draft = forge.buildSkillDraft({
    goal: 'Extract PDF text',
    steps: ['open pdf', 'run pdf-extract', 'fallback to OCR when missing', 'write output'],
    triggers: ['working with pdf documents', 'extract pdf text from files'],
    tools: ['read', 'bash', 'write'],
    validate: 'compare extracted text with source',
    fallback: 'use OCR when pdf-extract is unavailable',
  });
  assert.ok(forge.NAME_RE.test(draft.name), '草稿名应合法: ' + draft.name);
  assert.match(draft.description, /use when/i);

  const validation = forge.validateSkill(draft, {
    queries: ['extract pdf text', 'working with pdf documents'],
  });
  assert.strictEqual(validation.passed, true, '草稿应通过验证: ' + validation.reason);

  const forged = forge.forgeSkill(draft, {
    knowledge,
    queries: ['extract pdf text', 'working with pdf documents'],
  });
  assert.strictEqual(forged.ok, true, '入库应成功: ' + forged.reason);

  // ---- 4. 验证技能库确有该技能 ----
  const skills = knowledge.listSkills();
  assert.strictEqual(skills.length, 1, '技能库应有 1 个技能');
  assert.strictEqual(skills[0].name, draft.name);
  assert.ok(knowledge.readSkill(draft.name).length > 0, '技能正文应可读');

  // ---- 5. 记录使用（含失败）→ 迭代分析识别 ----
  const name = draft.name;
  evolver.recordUsage(name, { success: true, durationMs: 100 });
  evolver.recordUsage(name, { success: false, durationMs: 200 });
  evolver.recordUsage(name, { success: false, durationMs: 300 });
  evolver.recordUsage(name, { success: true, durationMs: 150 });

  const stat = evolver.getStat(name);
  assert.ok(stat, '统计应存在');
  assert.strictEqual(stat.uses, 4);
  assert.strictEqual(stat.success, 2);
  assert.strictEqual(stat.fail, 2);
  assert.strictEqual(stat.totalMs, 750);

  const rate = evolver.successRate(stat);
  assert.strictEqual(rate, 0.5, '成功率应为 0.5');

  // 使用满 3 次且成功率 0.5 < 0.7 → 应进入 needOptimize
  const report = evolver.analyze();
  assert.ok(
    report.needOptimize.some((s) => s.name === name),
    '低成功率技能应出现在 needOptimize'
  );
  const opt = report.needOptimize.find((s) => s.name === name);
  assert.ok(/成功率低/.test(opt.reason), 'reason 应指出成功率低: ' + opt.reason);
});

// ========== 埋点闭环：recordUsage 与技能使用一致 ==========

test('埋点闭环：技能使用记录能被迭代分析消费', () => {
  const { forge, evolver, knowledge } = freshModules();

  const draft = forge.buildSkillDraft({
    goal: 'Write Party Report',
    steps: ['collect data', 'draft outline', 'write sections'],
    triggers: ['writing party report', '党建报告写作'],
  });
  const forged = forge.forgeSkill(draft, {
    knowledge,
    queries: [draft.description.split('.')[0], 'writing party report'],
  });
  assert.strictEqual(forged.ok, true, forged.reason);

  // 模拟技能被使用多次（埋点写入的就是这条通道）
  for (let i = 0; i < 5; i++) evolver.recordUsage(draft.name, { success: true, durationMs: 100 });

  const stat = evolver.getStat(draft.name);
  assert.strictEqual(stat.uses, 5);
  assert.strictEqual(evolver.successRate(stat), 1);

  const report = evolver.analyze();
  assert.ok(
    report.healthy.some((s) => s.name === draft.name),
    '全成功技能应归入 healthy'
  );
  assert.strictEqual(report.summary.total, 1);
});

// ========== 边界：验证不通过的草稿不入库，库保持空 ==========

test('端到端：非法草稿被拒，技能库保持空', () => {
  const { forge, knowledge } = freshModules();

  const bad = forge.forgeSkill(
    { name: 'BAD_NAME', description: 'x', content: '' },
    { knowledge, queries: ['y'] }
  );
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(knowledge.listSkills().length, 0, '拒绝后技能库应保持空');
});
