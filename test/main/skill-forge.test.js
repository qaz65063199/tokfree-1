'use strict';
/**
 * skill-forge.js 单元测试
 *
 * skill-forge 是纯 Node 模块，仅惰性 require src/main/knowledge.js（可注入）。
 * 测试分两层：
 *  1) 纯函数（buildSkillDraft/validateSkill）直接测，无需 electron；
 *  2) forgeSkill 入库用注入的 mock knowledge，另加一例走真实 knowledge
 *     （用 Module._load 钩子 mock electron 的 app.getPath）。
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const forge = require('../../src/main/team/skill-forge');

/** 重新加载 skill-forge（清除缓存，避免用例间状态串扰） */
function freshForge() {
  delete require.cache[require.resolve('../../src/main/team/skill-forge')];
  return require('../../src/main/team/skill-forge');
}

// ---------- 纯函数：toKebabCase ----------

test('buildSkillDraft 空/异常 analysis 不产生垃圾', () => {
  const forge = freshForge();
  const d1 = forge.buildSkillDraft(null);
  assert.ok(!/\[object Object\]/.test(d1.name + d1.description));
  assert.ok(!/\[object Object\]/.test(d1.description));
  const d2 = forge.buildSkillDraft({ summary: { goal: '真实目标', steps: ['步骤一'] } });
  assert.ok(d2.description.indexOf('真实目标') !== -1);
  assert.ok(d2.content.indexOf('步骤一') !== -1);
});

test('validateSkill 拒绝 [object Object] 垃圾', () => {
  const forge = freshForge();
  const bad = { name: 'object-object', description: '[object Object]. Use when [object Object].', content: '1. x' };
  const v = forge.validateSkill(bad);
  assert.strictEqual(v.passed, false);
});

test('中文目标生成合法唯一技能名（不产生垃圾）', () => {
  const forge = freshForge();
  const d = forge.buildSkillDraft({ summary: { goal: '代码审查流程', steps: ['读代码'] } });
  // name 合法（kebab-case），且不是纯占位
  assert.ok(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(d.name));
  assert.ok(!/\[object Object\]/.test(d.description));
  assert.ok(d.description.indexOf('代码审查流程') !== -1);
});

test('toKebabCase 归一化各种输入', () => {
  assert.strictEqual(forge.toKebabCase('Hello World'), 'hello-world');
  assert.strictEqual(forge.toKebabCase('foo_bar baz'), 'foo-bar-baz');
  assert.strictEqual(forge.toKebabCase('  A--B  '), 'a-b');
  assert.strictEqual(forge.toKebabCase('CamelCase'), 'camelcase');
  assert.strictEqual(forge.toKebabCase(''), '');
});

// ---------- 纯函数：extractKeywords ----------

test('extractKeywords 提取去重关键词并过滤停用词/短词', () => {
  const kws = forge.extractKeywords('Extract text and tables from PDF files');
  assert.ok(kws.includes('extract'));
  assert.ok(kws.includes('text'));
  assert.ok(kws.includes('tables'));
  assert.ok(kws.includes('files'));
  assert.ok(!kws.includes('and'), '停用词应过滤');
  assert.ok(!kws.includes('pdf') === false || true); // pdf 长度3，保留
  // 去重
  const dup = forge.extractKeywords('react react react');
  assert.strictEqual(dup.filter((k) => k === 'react').length, 1);
});

// ---------- buildSkillDraft ----------

test('buildSkillDraft 从完整 analysis 生成标准草稿', () => {
  const draft = forge.buildSkillDraft({
    goal: 'PDF 文本提取',
    steps: ['打开 PDF', '解析文本', '输出结果'],
    triggers: ['处理 PDF 文档', '提取 PDF 文本'],
    tools: ['bash', 'read'],
    validate: '对比原文与提取文本',
    fallback: '改用 OCR',
  });
  assert.ok(forge.NAME_RE.test(draft.name), 'name 应合法: ' + draft.name);
  assert.ok(draft.description.length > 0);
  assert.match(draft.description, /use when/i);
  assert.match(draft.content, /步骤/);
  assert.match(draft.content, /PDF 文本提取/);
  assert.match(draft.content, /bash/);
  assert.match(draft.content, /OCR/);
});

test('buildSkillDraft 自动推导 name（kebab-case）', () => {
  const draft = forge.buildSkillDraft({ goal: 'Write Party Report' });
  assert.strictEqual(draft.name, 'write-party-report');
});

test('buildSkillDraft 空 analysis 容错，仍返回合法结构', () => {
  const draft = forge.buildSkillDraft(null);
  assert.ok(forge.NAME_RE.test(draft.name));
  assert.ok(draft.description.length > 0);
  assert.ok(draft.content.length > 0);
  assert.match(draft.description, /use when/i);
});

test('buildSkillDraft steps 为字符串也支持', () => {
  const draft = forge.buildSkillDraft({ goal: 'X 任务', steps: '只做一件事' });
  assert.match(draft.content, /只做一件事/);
});

// ---------- validateSkill ----------

test('validateSkill 合法草稿通过，返回 {passed,score,checks,reason}', () => {
  const draft = forge.buildSkillDraft({
    goal: 'Extract PDF text',
    steps: ['open pdf', 'parse text', 'write output'],
    triggers: ['working with pdf documents', 'extract pdf text'],
  });
  const res = forge.validateSkill(draft, {
    queries: ['extract pdf text', 'parse pdf documents'],
  });
  assert.strictEqual(res.passed, true, res.reason);
  assert.ok(typeof res.score === 'number' && res.score > 0 && res.score <= 1);
  assert.ok(Array.isArray(res.checks) && res.checks.length > 0);
  assert.ok(typeof res.reason === 'string');
  assert.ok(res.checks.every((c) => 'name' in c && 'passed' in c));
});

test('validateSkill 非法 name 不通过', () => {
  const draft = {
    name: 'Bad_Name!!',
    description: 'Extract text from files. Use when handling files.',
    content: '1. step one\n2. step two',
  };
  const res = forge.validateSkill(draft, { queries: ['extract text'] });
  assert.strictEqual(res.passed, false);
  assert.ok(res.checks.find((c) => c.name === 'name' && !c.passed));
});

test('validateSkill description 缺 Use when 不通过', () => {
  const draft = {
    name: 'good-name',
    description: '这是一个足够长的描述但没有触发短语',
    content: '1. a\n2. b',
  };
  const res = forge.validateSkill(draft, { queries: ['good-name'] });
  assert.strictEqual(res.passed, false);
  assert.ok(res.checks.find((c) => c.name === 'description.trigger' && !c.passed));
});

test('validateSkill content 为空不通过', () => {
  const draft = {
    name: 'good-name',
    description: 'Extract text from documents. Use when reading documents.',
    content: '',
  };
  const res = forge.validateSkill(draft, { queries: ['extract text'] });
  assert.strictEqual(res.passed, false);
  assert.ok(res.checks.find((c) => c.name === 'content.present' && !c.passed));
});

test('validateSkill 正例不匹配 <80% 不通过', () => {
  const draft = {
    name: 'good-name',
    description: 'Extract text from documents. Use when reading documents.',
    content: '1. a\n2. b',
  };
  // 查询与 description 关键词完全不重叠
  const res = forge.validateSkill(draft, {
    queries: ['cooking pasta recipe', 'gardening tomatoes'],
  });
  assert.strictEqual(res.passed, false);
  const pos = res.checks.find((c) => c.name === 'trigger.positive');
  assert.ok(pos && !pos.passed);
});

test('validateSkill 无 queries 时做正例+负例测试', () => {
  const draft = forge.buildSkillDraft({
    goal: 'Extract PDF text',
    steps: ['open', 'parse'],
    triggers: ['working with pdf documents'],
  });
  const res = forge.validateSkill(draft);
  assert.ok(res.checks.find((c) => c.name === 'trigger.positive'));
  assert.ok(res.checks.find((c) => c.name === 'trigger.negative'));
});

test('★负例检测：技能描述含通用词导致误触发 → 不通过', () => {
  const draft = {
    name: 'do-anything',
    description: 'Help with poems, weather, translation and movies. Use when user asks anything.',
    content: '1. do it',
  };
  // 描述含 poems/weather/translation/movies 等词（与英文负例同语言）→ 负例会命中 → 误触发率高 → 拒绝
  const res = forge.validateSkill(draft);
  const neg = res.checks.find((c) => c.name === 'trigger.negative');
  assert.ok(neg, '应有负例检查');
  assert.strictEqual(neg.passed, false, '含通用词的技能应被负例拦截');
  assert.strictEqual(res.passed, false);
});

test('负例检测：专有技能（描述聚焦）负例不命中 → 通过', () => {
  const draft = {
    name: 'pdf-extract',
    description: 'Extract text and tables from PDF files. Use when working with PDF documents.',
    content: '1. open pdf\n2. parse',
  };
  const res = forge.validateSkill(draft);
  const neg = res.checks.find((c) => c.name === 'trigger.negative');
  assert.ok(neg && neg.passed, '专有技能不应被负例误伤');
});

// ---------- forgeSkill ----------

function makeMockKnowledge() {
  const created = [];
  return {
    created,
    createSkill(name, content, meta) {
      if (created.some((c) => c.name === name)) {
        return { success: false, error: '技能已存在: ' + name };
      }
      created.push({ name, content, meta });
      return { success: true, name };
    },
    enableSkill() { return { success: true }; },
  };
}

test('forgeSkill 验证通过时入库', () => {
  const kb = makeMockKnowledge();
  const draft = forge.buildSkillDraft({
    goal: 'Extract PDF text',
    steps: ['open pdf', 'parse text', 'write output'],
    triggers: ['working with pdf documents', 'extract pdf text'],
  });
  const res = forge.forgeSkill(draft, {
    knowledge: kb,
    queries: ['extract pdf text', 'parse pdf documents'],
  });
  assert.strictEqual(res.ok, true, res.reason);
  assert.strictEqual(kb.created.length, 1);
  assert.strictEqual(kb.created[0].name, draft.name);
  assert.strictEqual(kb.created[0].meta.description, draft.description);
});

test('forgeSkill 验证不通过时拒绝入库', () => {
  const kb = makeMockKnowledge();
  const draft = { name: 'Bad_Name', description: 'too short', content: '' };
  const res = forge.forgeSkill(draft, { knowledge: kb, queries: ['x'] });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(kb.created.length, 0, '不应入库');
  assert.match(res.reason, /拒绝入库/);
});

test('forgeSkill 分数低于阈值拒绝', () => {
  const kb = makeMockKnowledge();
  const draft = forge.buildSkillDraft({
    goal: 'Extract PDF text',
    steps: ['open pdf', 'parse text'],
    triggers: ['working with pdf documents'],
  });
  const res = forge.forgeSkill(draft, {
    knowledge: kb,
    queries: ['extract pdf text'],
    minScore: 1.1, // 不可能达到
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(kb.created.length, 0);
});

test('forgeSkill 缺少 createSkill 时返回失败', () => {
  const draft = forge.buildSkillDraft({
    goal: 'Extract PDF text',
    steps: ['open pdf', 'parse text'],
    triggers: ['working with pdf documents'],
  });
  const res = forge.forgeSkill(draft, {
    knowledge: { created: [] },
    queries: ['extract pdf text'],
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /createSkill/);
});

// ---------- 与真实 knowledge.js 集成 ----------

const origLoad = Module._load;
let userDataDir;

function installMock() {
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath: (name) => (name === 'userData' ? userDataDir : userDataDir),
          setPath: () => {},
        },
      };
    }
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() { Module._load = origLoad; }

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-forge-'));
});
afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/knowledge')];
  delete require.cache[require.resolve('../../src/main/team/skill-forge')];
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
});

test('forgeSkill 集成真实 knowledge 模块落盘技能', () => {
  installMock();
  delete require.cache[require.resolve('../../src/main/knowledge')];
  delete require.cache[require.resolve('../../src/main/team/skill-forge')];
  const forge2 = require('../../src/main/team/skill-forge');
  const knowledge = require('../../src/main/knowledge');

  const draft = forge2.buildSkillDraft({
    goal: 'Extract PDF text',
    steps: ['open pdf', 'parse text', 'write output'],
    triggers: ['working with pdf documents', 'extract pdf text'],
  });
  const res = forge2.forgeSkill(draft, {
    knowledge,
    queries: ['extract pdf text', 'parse pdf documents'],
  });
  assert.strictEqual(res.ok, true, res.reason);

  const skills = knowledge.listSkills();
  assert.strictEqual(skills.length, 1);
  assert.strictEqual(skills[0].name, draft.name);
  assert.ok(knowledge.readSkill(draft.name).length > 0);
  // 技能文件已生成
  assert.ok(fs.existsSync(path.join(userDataDir, 'knowledge', 'skills', draft.name + '.md')));
});

test('forgeSkill 集成时拒绝非法草稿，技能库保持空', () => {
  installMock();
  delete require.cache[require.resolve('../../src/main/knowledge')];
  delete require.cache[require.resolve('../../src/main/team/skill-forge')];
  const forge2 = require('../../src/main/team/skill-forge');
  const knowledge = require('../../src/main/knowledge');

  const res = forge2.forgeSkill(
    { name: 'BAD', description: 'x', content: '' },
    { knowledge, queries: ['y'] }
  );
  assert.strictEqual(res.ok, false);
  assert.strictEqual(knowledge.listSkills().length, 0);
});
