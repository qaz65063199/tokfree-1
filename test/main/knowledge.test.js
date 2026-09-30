'use strict';
/**
 * knowledge.js 单元测试
 *
 * knowledge.js 依赖 electron 的 app.getPath('userData') 定位存储目录。
 * 参照 test/main/profile-manager.test.js 的做法，用 Module._load 钩子 mock
 * electron，把 userData 指向临时目录，隔离文件系统副作用。
 *
 * 注意：enable/disable/getEnabledSkills 是"项目级"接口，第一个参数是 projectDir。
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const origLoad = Module._load;

let userDataDir;   // 模拟 userData
let projectDir;    // 模拟某个项目目录

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
function uninstallMock() {
  Module._load = origLoad;
}

function freshKnowledge() {
  delete require.cache[require.resolve('../../src/main/knowledge')];
  return require('../../src/main/knowledge');
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-know-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-proj-'));
  installMock();
});

afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/knowledge')];
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch (_) {}
});

function skillsDir() {
  return path.join(userDataDir, 'knowledge', 'skills');
}
function prefsFile() {
  return path.join(userDataDir, 'knowledge', 'preferences.md');
}
function registryFile() {
  return path.join(userDataDir, 'knowledge', 'skills.json');
}
function enabledFile() {
  return path.join(projectDir, '.tokfreeCode', 'enabled-skills.json');
}

// ========== createSkill ==========

test('createSkill 成功创建技能', () => {
  const k = freshKnowledge();
  const res = k.createSkill('my-skill', '# My Skill\n正文', { description: '示例', tags: ['a'] });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.name, 'my-skill');
  assert.ok(fs.existsSync(path.join(skillsDir(), 'my-skill.md')), '技能正文文件应存在');
  assert.strictEqual(k.readSkill('my-skill'), '# My Skill\n正文');
  const list = k.listSkills();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'my-skill');
  assert.strictEqual(list[0].description, '示例');
  assert.deepStrictEqual(list[0].tags, ['a']);
  assert.ok(list[0].createdAt);
});

test('createSkill 重名时报错', () => {
  const k = freshKnowledge();
  k.createSkill('dup', 'first');
  const res = k.createSkill('dup', 'second');
  assert.strictEqual(res.success, false);
  assert.match(res.error, /已存在/);
});

test('createSkill 非法名报错', () => {
  const k = freshKnowledge();
  for (const bad of ['', 'a/b', '../evil', 'a b', 'a.b', null, undefined]) {
    const res = k.createSkill(bad, 'x');
    assert.strictEqual(res.success, false, '非法名应失败: ' + String(bad));
    assert.match(res.error, /非法/);
  }
});

test('createSkill 合法名允许字母数字下划线连字符', () => {
  const k = freshKnowledge();
  for (const ok of ['abc', 'ABC', 'a_b-c', '123']) {
    const res = k.createSkill(ok, 'x');
    assert.strictEqual(res.success, true, '合法名应成功: ' + ok);
  }
});

// ========== readSkill ==========

test('readSkill 读取存在的技能', () => {
  const k = freshKnowledge();
  k.createSkill('read-me', 'hello world');
  assert.strictEqual(k.readSkill('read-me'), 'hello world');
});

test('readSkill 不存在返回 null', () => {
  const k = freshKnowledge();
  assert.strictEqual(k.readSkill('nope'), null);
});

test('readSkill 对非法名返回 null（防目录穿越）', () => {
  const k = freshKnowledge();
  // 在 skills 目录外放一个 .md，确认穿越读不到
  const outside = path.join(userDataDir, 'secret.md');
  fs.writeFileSync(outside, 'TOP_SECRET', 'utf-8');
  for (const bad of ['../secret', '../../secret', 'a/b', 'a\\b', 'a.b', '', null, undefined]) {
    assert.strictEqual(k.readSkill(bad), null, '非法名应返回 null: ' + String(bad));
  }
  assert.ok(fs.existsSync(outside), '外部文件不应被读取/移动');
});

// ========== updateSkill ==========

test('updateSkill 更新正文与元数据', () => {
  const k = freshKnowledge();
  k.createSkill('u', 'old', { description: 'd1', tags: ['x'] });
  const res = k.updateSkill('u', 'new content', { description: 'd2', tags: ['y', 'z'] });
  assert.strictEqual(res.success, true);
  assert.strictEqual(k.readSkill('u'), 'new content');
  const item = k.listSkills().find((s) => s.name === 'u');
  assert.strictEqual(item.description, 'd2');
  assert.deepStrictEqual(item.tags, ['y', 'z']);
});

test('updateSkill 只传 meta 不改正文', () => {
  const k = freshKnowledge();
  k.createSkill('u2', 'body', { description: 'd1' });
  const res = k.updateSkill('u2', undefined, { description: 'd2' });
  assert.strictEqual(res.success, true);
  assert.strictEqual(k.readSkill('u2'), 'body');
  assert.strictEqual(k.listSkills().find((s) => s.name === 'u2').description, 'd2');
});

test('updateSkill 对不存在技能返回错误', () => {
  const k = freshKnowledge();
  const res = k.updateSkill('ghost', 'x');
  assert.strictEqual(res.success, false);
  assert.match(res.error, /不存在/);
});

test('updateSkill 对非法名返回错误且不写外部文件', () => {
  const k = freshKnowledge();
  const outside = path.join(userDataDir, 'victim.md');
  const res = k.updateSkill('../victim', 'HACKED');
  assert.strictEqual(res.success, false);
  assert.match(res.error, /非法/);
  assert.ok(!fs.existsSync(outside), '不应在目录外创建文件');
});

// ========== deleteSkill ==========

test('deleteSkill 删除技能正文与注册项', () => {
  const k = freshKnowledge();
  k.createSkill('del-me', 'x');
  const res = k.deleteSkill('del-me');
  assert.strictEqual(res.success, true);
  assert.ok(!fs.existsSync(path.join(skillsDir(), 'del-me.md')));
  assert.strictEqual(k.listSkills().length, 0);
});

test('deleteSkill 对不存在技能返回错误', () => {
  const k = freshKnowledge();
  const res = k.deleteSkill('ghost');
  assert.strictEqual(res.success, false);
  assert.match(res.error, /不存在/);
});

test('deleteSkill 对非法名返回错误且不删外部文件', () => {
  const k = freshKnowledge();
  const outside = path.join(userDataDir, 'keep.md');
  fs.writeFileSync(outside, 'IMPORTANT', 'utf-8');
  const res = k.deleteSkill('../keep');
  assert.strictEqual(res.success, false);
  assert.match(res.error, /非法/);
  assert.ok(fs.existsSync(outside), '外部文件不应被删除');
});

// ========== 启用 / 禁用（项目级） ==========

test('enableSkill / getEnabledSkills / disableSkill 完整流程', () => {
  const k = freshKnowledge();
  k.createSkill('en', 'x');

  let res = k.enableSkill(projectDir, 'en');
  assert.strictEqual(res.success, true);
  assert.deepStrictEqual(k.getEnabledSkills(projectDir), ['en']);
  assert.ok(fs.existsSync(enabledFile()), 'enabled-skills.json 应生成');

  // 重复启用幂等
  res = k.enableSkill(projectDir, 'en');
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.already, true);
  assert.deepStrictEqual(k.getEnabledSkills(projectDir), ['en']);

  res = k.disableSkill(projectDir, 'en');
  assert.strictEqual(res.success, true);
  assert.deepStrictEqual(k.getEnabledSkills(projectDir), []);

  // 重复禁用幂等
  res = k.disableSkill(projectDir, 'en');
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.already, true);
});

test('enableSkill 对不存在技能返回错误', () => {
  const k = freshKnowledge();
  const res = k.enableSkill(projectDir, 'ghost');
  assert.strictEqual(res.success, false);
  assert.match(res.error, /不存在/);
});

test('getEnabledSkills 无文件返回空数组', () => {
  const k = freshKnowledge();
  assert.deepStrictEqual(k.getEnabledSkills(projectDir), []);
});

test('不同项目启用状态互相隔离', () => {
  const k = freshKnowledge();
  const proj2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-proj2-'));
  k.createSkill('s', 'x');
  k.enableSkill(projectDir, 's');
  assert.deepStrictEqual(k.getEnabledSkills(projectDir), ['s']);
  assert.deepStrictEqual(k.getEnabledSkills(proj2), []);
  fs.rmSync(proj2, { recursive: true, force: true });
});

// ========== 全局偏好 ==========

test('readPreferences 首次返回默认模板并落盘', () => {
  const k = freshKnowledge();
  const prefs = k.readPreferences();
  assert.match(prefs, /# 全局偏好/);
  assert.ok(fs.existsSync(prefsFile()), 'preferences.md 应被创建');
});

test('writePreferences / readPreferences 往返', () => {
  const k = freshKnowledge();
  assert.strictEqual(k.writePreferences('自定义内容'), true);
  assert.strictEqual(k.readPreferences(), '自定义内容');
});

test('appendPreference 追加且自动加 - 前缀', () => {
  const k = freshKnowledge();
  k.writePreferences('# 全局偏好\n');
  k.appendPreference('喜欢用 tabs');
  k.appendPreference('代码注释用中文');
  const prefs = k.readPreferences();
  assert.match(prefs, /- 喜欢用 tabs/);
  assert.match(prefs, /- 代码注释用中文/);
});

test('appendPreference 对空白输入仍写入 - 前缀行', () => {
  const k = freshKnowledge();
  k.writePreferences('X\n');
  k.appendPreference('   ');
  assert.match(k.readPreferences(), /- \n?$/m);
});

// ========== buildKnowledgeSection ==========

test('buildKnowledgeSection 无偏好无技能时仅含使用说明', () => {
  const k = freshKnowledge();
  // 默认模板含"（待补充）"，会走"尚未填写偏好"分支
  const section = k.buildKnowledgeSection(null);
  assert.match(section, /用户全局偏好/);
  assert.match(section, /尚未填写偏好/);
  assert.match(section, /技能库/);
  assert.ok(!section.includes('本项目已启用的技能'), '无项目时不应有启用技能章节');
});

test('buildKnowledgeSection 有偏好时包含偏好正文', () => {
  const k = freshKnowledge();
  k.writePreferences('# 我的偏好\n- 偏好A');
  const section = k.buildKnowledgeSection(null);
  assert.match(section, /偏好A/);
  assert.ok(!section.includes('尚未填写偏好'));
});

test('buildKnowledgeSection 有启用技能时包含技能正文', () => {
  const k = freshKnowledge();
  k.writePreferences('# 偏好\n- 偏好A');
  k.createSkill('skill-x', '技能内容X');
  k.enableSkill(projectDir, 'skill-x');
  const section = k.buildKnowledgeSection(projectDir);
  assert.match(section, /本项目已启用的技能/);
  assert.match(section, /技能：skill-x/);
  assert.match(section, /技能内容X/);
});

test('buildKnowledgeSection 未启用技能不出现在章节', () => {
  const k = freshKnowledge();
  k.writePreferences('# 偏好\n- 偏好A');
  k.createSkill('skill-y', '技能内容Y');
  const section = k.buildKnowledgeSection(projectDir);
  assert.ok(!section.includes('技能内容Y'), '未启用技能不应注入');
  assert.ok(!section.includes('本项目已启用的技能'));
});

test('buildKnowledgeSection 偏好+技能组合都包含', () => {
  const k = freshKnowledge();
  k.writePreferences('# 偏好\n- 组合偏好');
  k.createSkill('combo', '组合技能正文');
  k.enableSkill(projectDir, 'combo');
  const section = k.buildKnowledgeSection(projectDir);
  assert.match(section, /组合偏好/);
  assert.match(section, /组合技能正文/);
  assert.match(section, /技能库/);
});

// ========== 损坏文件容错 ==========

function corruptBackups(file) {
  const dir = path.dirname(file);
  const base = path.basename(file) + '.corrupt-';
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.startsWith(base));
}

test('skills.json 损坏时返回空注册表并备份损坏文件', () => {
  const k = freshKnowledge();
  k.createSkill('a', 'x'); // 先确保目录存在
  fs.writeFileSync(registryFile(), '{ this is not json', 'utf-8');
  const list = k.listSkills();
  assert.deepStrictEqual(list, []);
  const backups = corruptBackups(registryFile());
  assert.strictEqual(backups.length, 1, '应生成一个损坏备份');
  assert.strictEqual(fs.readFileSync(path.join(path.dirname(registryFile()), backups[0]), 'utf-8'), '{ this is not json');
});

test('skills.json 结构非法（skills 非数组）时备份', () => {
  const k = freshKnowledge();
  k.createSkill('a', 'x');
  fs.writeFileSync(registryFile(), JSON.stringify({ skills: 'oops' }), 'utf-8');
  assert.deepStrictEqual(k.listSkills(), []);
  assert.strictEqual(corruptBackups(registryFile()).length, 1);
});

test('enabled-skills.json 损坏时返回空数组并备份', () => {
  const k = freshKnowledge();
  const f = enabledFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'not-json', 'utf-8');
  assert.deepStrictEqual(k.getEnabledSkills(projectDir), []);
  const dir = path.dirname(f);
  const backups = fs.readdirSync(dir).filter((n) => n.startsWith('enabled-skills.json.corrupt-'));
  assert.strictEqual(backups.length, 1, '应生成一个损坏备份');
});

test('注册表正常时不会产生损坏备份', () => {
  const k = freshKnowledge();
  k.createSkill('ok', 'x');
  k.listSkills();
  assert.strictEqual(corruptBackups(registryFile()).length, 0);
});

// ========== 失效引用容错 ==========

test('删除技能后 buildKnowledgeSection 忽略项目中的失效引用', () => {
  const k = freshKnowledge();
  k.writePreferences('# 偏好\n- 偏好A');
  k.createSkill('will-delete', '技能正文ZZZ');
  k.enableSkill(projectDir, 'will-delete');
  k.deleteSkill('will-delete');
  // enabled-skills.json 仍引用旧名，不应抛错、不应注入已删技能
  const section = k.buildKnowledgeSection(projectDir);
  assert.ok(!section.includes('技能正文ZZZ'));
  assert.ok(!section.includes('技能：will-delete'));
  assert.match(section, /技能库/);
});

// ========== 路径与持久化 ==========

test('getKnowledgeDir / getSkillsDir 位于 userData 下', () => {
  const k = freshKnowledge();
  assert.strictEqual(k.getKnowledgeDir(), path.join(userDataDir, 'knowledge'));
  assert.strictEqual(k.getSkillsDir(), path.join(userDataDir, 'knowledge', 'skills'));
  assert.ok(fs.existsSync(k.getKnowledgeDir()));
  assert.ok(fs.existsSync(k.getSkillsDir()));
});

test('注册表持久化为 JSON 且可重新加载', () => {
  const k = freshKnowledge();
  k.createSkill('persist', 'x');
  assert.ok(fs.existsSync(registryFile()));
  const raw = JSON.parse(fs.readFileSync(registryFile(), 'utf-8'));
  assert.strictEqual(raw.skills.length, 1);
  assert.strictEqual(raw.skills[0].name, 'persist');

  const k2 = freshKnowledge();
  assert.strictEqual(k2.listSkills().length, 1);
});
