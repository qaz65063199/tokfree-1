'use strict';
/**
 * flywheel-skill.js 单元测试
 *
 * flywheel-skill 是纯 Node 模块，仅惰性 require src/main/knowledge.js（可注入）。
 * 测试分三层：
 *  1) FLYWHEEL_SKILL_CONTENT 结构：6 步 + 每步「做什么/产出」+ 第4步分流 + 第6步清理关键词；
 *  2) seedSkill() 幂等：用注入的 mock knowledge，第一次 created=true，第二次 created=false；
 *  3) seedSkill() 版本升级：已存在旧版本 → 调 updateSkill 覆盖；已是最新 → 不动。
 * 另加一例走真实 knowledge（Module._load 钩子 mock electron 的 app.getPath）。
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const flywheel = require('../../src/main/team/flywheel-skill');

// ---------- 内容结构 ----------

test('FLYWHEEL_SKILL_NAME 为 kebab-case', () => {
  assert.strictEqual(flywheel.FLYWHEEL_SKILL_NAME, 'evolution-flywheel');
  assert.ok(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(flywheel.FLYWHEEL_SKILL_NAME));
});

test('SOP 版本号为 2', () => {
  assert.strictEqual(flywheel.FLYWHEEL_SKILL_VERSION, 2);
});

test('SOP 内容含 6 个步骤标题', () => {
  const c = flywheel.FLYWHEEL_SKILL_CONTENT;
  assert.match(c, /第 1 步 · 网上调研/);
  assert.match(c, /第 2 步 · 本地盘点/);
  assert.match(c, /第 3 步 · 补充待办/);
  assert.match(c, /第 4 步 · 执行/);
  assert.match(c, /第 5 步 · 复盘沉淀/);
  assert.match(c, /第 6 步 · 评估与清理/);
});

test('SOP 为分步式：含总览 + 每步「做什么/产出」+「读 skill 查看下一步」', () => {
  const c = flywheel.FLYWHEEL_SKILL_CONTENT;
  assert.match(c, /6 步总览/);
  // 6 个「做什么」与「产出」
  const doCount = (c.match(/做什么：/g) || []).length;
  const outCount = (c.match(/产出：/g) || []).length;
  assert.ok(doCount >= 6, '至少 6 个「做什么」，实际 ' + doCount);
  assert.ok(outCount >= 6, '至少 6 个「产出」，实际 ' + outCount);
  // 分步引导：做完读 skill 拿下一步
  assert.match(c, /读 skill 查看第 2 步/);
  assert.match(c, /读 skill 查看第 5 步/);
  // 铁律里的分步说明
  assert.match(c, /一次只做一步/);
});

test('SOP 第 4 步按单/多 Agent 分流', () => {
  const c = flywheel.FLYWHEEL_SKILL_CONTENT;
  assert.match(c, /单 Agent 模式/);
  assert.match(c, /多 Agent 模式/);
  assert.match(c, /auto_goal_create/);
  assert.match(c, /projectDir/);
});

test('SOP 第 6 步含评估 + 清理关键词', () => {
  const c = flywheel.FLYWHEEL_SKILL_CONTENT;
  assert.match(c, /评估/);
  assert.match(c, /已升级/);
  assert.match(c, /清理/);
  assert.match(c, /checkpoints/);
  assert.match(c, /已清理/);
});

test('SOP 内容含铁律（只针对本项目 + 不许跳过）', () => {
  const c = flywheel.FLYWHEEL_SKILL_CONTENT;
  assert.match(c, /铁律/);
  assert.match(c, /本项目/);
  assert.match(c, /绝不涉及其他项目/);
  assert.match(c, /不要跳步/);
});

test('SOP 内容含使用场景（战略巡检简报/自驱循环）', () => {
  const c = flywheel.FLYWHEEL_SKILL_CONTENT;
  assert.match(c, /战略巡检简报/);
  assert.match(c, /自驱循环/);
});

test('SOP 步骤里点名了关键工具', () => {
  const c = flywheel.FLYWHEEL_SKILL_CONTENT;
  assert.match(c, /web_fetch/);
  assert.match(c, /todo_write/);
  assert.match(c, /auto_retrospect/);
  assert.match(c, /auto_skill_forge/);
});

// ---------- seedSkill 幂等（mock knowledge） ----------

function makeMockKnowledge(seedSkills) {
  const created = [];
  const enabled = [];
  const updates = [];
  const skills = Array.isArray(seedSkills) ? seedSkills.slice() : [];
  return {
    created,
    enabled,
    updates,
    skills,
    createSkill(name, content, meta) {
      if (skills.some((c) => c.name === name) || created.some((c) => c.name === name)) {
        return { success: false, error: '技能已存在: ' + name };
      }
      created.push({ name, content, meta });
      skills.push({ name, description: (meta && meta.description) || '', tags: (meta && meta.tags) || [] });
      return { success: true, name };
    },
    listSkills() {
      const fromCreated = created.map((c) => ({ name: c.name, description: (c.meta && c.meta.description) || '', tags: (c.meta && c.meta.tags) || [] }));
      return skills.concat(fromCreated);
    },
    updateSkill(name, content, meta) {
      updates.push({ name, content, meta });
      const item = skills.find((s) => s.name === name);
      if (item) {
        if (meta) {
          if (typeof meta.description === 'string') item.description = meta.description;
          if (Array.isArray(meta.tags)) item.tags = meta.tags;
        }
      }
      return { success: true };
    },
    enableSkillGlobal(name) {
      if (enabled.indexOf(name) !== -1) return { success: true, already: true };
      enabled.push(name);
      return { success: true };
    },
  };
}

test('seedSkill 首次创建并全局启用（created=true, upgraded=false）', () => {
  const kb = makeMockKnowledge();
  const res = flywheel.seedSkill({ knowledge: kb });
  assert.strictEqual(res.created, true, JSON.stringify(res));
  assert.strictEqual(res.upgraded, false);
  assert.strictEqual(res.name, 'evolution-flywheel');
  assert.strictEqual(res.enabled, true);
  assert.strictEqual(kb.created.length, 1);
  assert.strictEqual(kb.created[0].name, 'evolution-flywheel');
  assert.ok(kb.created[0].content.indexOf('第 6 步') !== -1);
  assert.ok(kb.enabled.indexOf('evolution-flywheel') !== -1);
});

test('seedSkill 幂等：第二次不重复创建（created=false），仍启用', () => {
  const kb = makeMockKnowledge();
  const r1 = flywheel.seedSkill({ knowledge: kb });
  const r2 = flywheel.seedSkill({ knowledge: kb });
  assert.strictEqual(r1.created, true);
  assert.strictEqual(r2.created, false);
  assert.strictEqual(r2.upgraded, false);
  assert.strictEqual(kb.created.length, 1, '只创建一次');
  assert.strictEqual(r2.enabled, true);
});

test('seedSkill 升级旧版本 skill（旧 tags 无 sop-v2 → 调 updateSkill 覆盖）', () => {
  const kb = makeMockKnowledge([
    { name: 'evolution-flywheel', description: 'old', tags: ['flywheel', 'sop', 'sop-v1'] },
  ]);
  const res = flywheel.seedSkill({ knowledge: kb });
  assert.strictEqual(res.created, false, JSON.stringify(res));
  assert.strictEqual(res.upgraded, true);
  assert.strictEqual(kb.created.length, 0, '不重复创建');
  assert.strictEqual(kb.updates.length, 1, '调一次 updateSkill');
  assert.strictEqual(kb.updates[0].name, 'evolution-flywheel');
  assert.ok(kb.updates[0].content.indexOf('第 6 步 · 评估与清理') !== -1);
  assert.ok(kb.updates[0].meta.tags.indexOf('sop-v2') !== -1);
});

test('seedSkill 已是最新版本不动（tags 含 sop-v2 → 不 updateSkill）', () => {
  const kb = makeMockKnowledge([
    { name: 'evolution-flywheel', description: 'latest', tags: ['flywheel', 'sop', 'sop-v2'] },
  ]);
  const res = flywheel.seedSkill({ knowledge: kb });
  assert.strictEqual(res.created, false);
  assert.strictEqual(res.upgraded, false);
  assert.strictEqual(kb.updates.length, 0, '不调 updateSkill');
  assert.strictEqual(res.enabled, true);
});

test('seedSkill knowledge 不可用时容错返回', () => {
  const res = flywheel.seedSkill({ knowledge: {} });
  assert.strictEqual(res.created, false);
  assert.strictEqual(res.upgraded, false);
  assert.ok(res.error);
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
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-flywheel-'));
});
afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/knowledge')];
  delete require.cache[require.resolve('../../src/main/team/flywheel-skill')];
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
});

test('seedSkill 集成真实 knowledge：落盘技能 + 全局启用 + 幂等', () => {
  installMock();
  delete require.cache[require.resolve('../../src/main/knowledge')];
  delete require.cache[require.resolve('../../src/main/team/flywheel-skill')];
  const fw = require('../../src/main/team/flywheel-skill');
  const knowledge = require('../../src/main/knowledge');

  const r1 = fw.seedSkill({ knowledge });
  assert.strictEqual(r1.created, true, JSON.stringify(r1));
  assert.strictEqual(r1.enabled, true);
  assert.ok(fs.existsSync(path.join(userDataDir, 'knowledge', 'skills', 'evolution-flywheel.md')));
  assert.ok(knowledge.readSkill('evolution-flywheel').indexOf('第 6 步') !== -1);
  assert.ok(knowledge.getGlobalEnabledSkills().indexOf('evolution-flywheel') !== -1);

  const r2 = fw.seedSkill({ knowledge });
  assert.strictEqual(r2.created, false, '重复 seed 不重复创建');
  assert.strictEqual(knowledge.listSkills().filter((s) => s.name === 'evolution-flywheel').length, 1);
});

test('seedSkill 集成真实 knowledge：旧版本落盘 skill 会被升级为 v2', () => {
  installMock();
  // 预置一个 v1（无 sop-v2 tag）的 skill
  const skillsDir = path.join(userDataDir, 'knowledge', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'evolution-flywheel.md'), '# 旧版 5 步 SOP', 'utf-8');
  fs.writeFileSync(
    path.join(userDataDir, 'knowledge', 'skills.json'),
    JSON.stringify({
      skills: [{ name: 'evolution-flywheel', description: 'old', tags: ['flywheel', 'sop-v1'], createdAt: new Date().toISOString() }],
    }),
    'utf-8'
  );

  delete require.cache[require.resolve('../../src/main/knowledge')];
  delete require.cache[require.resolve('../../src/main/team/flywheel-skill')];
  const fw = require('../../src/main/team/flywheel-skill');
  const knowledge = require('../../src/main/knowledge');

  const res = fw.seedSkill({ knowledge });
  assert.strictEqual(res.created, false, JSON.stringify(res));
  assert.strictEqual(res.upgraded, true, JSON.stringify(res));
  assert.ok(knowledge.readSkill('evolution-flywheel').indexOf('第 6 步 · 评估与清理') !== -1, '正文已升级为 v2');
  assert.strictEqual(knowledge.listSkills().filter((s) => s.name === 'evolution-flywheel').length, 1, '不重复创建');
});
