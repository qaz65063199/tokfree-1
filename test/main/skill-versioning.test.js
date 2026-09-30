'use strict';
/**
 * skill-versioning.test.js —— 技能版本化（快照 + 回退）单元测试
 *
 * 参照 test/main/knowledge.test.js，用 Module._load 钩子 mock electron，
 * 把 userData 指向临时目录，隔离文件系统副作用。
 *
 * 覆盖：update 自动快照、listSkillVersions、restoreSkillVersion 回退正确、
 *       保留 20 个上限、损坏 active.json 容错、无版本时空列表、非法参数。
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
function uninstallMock() {
  Module._load = origLoad;
}

function freshKnowledge() {
  delete require.cache[require.resolve('../../src/main/knowledge')];
  return require('../../src/main/knowledge');
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-skillver-'));
  installMock();
});

afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/knowledge')];
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
});

function skillsDir() {
  return path.join(userDataDir, 'knowledge', 'skills');
}
function versionsDir(name) {
  return path.join(skillsDir(), name, 'versions');
}
function activeFile(name) {
  return path.join(skillsDir(), name, 'active.json');
}
function bodyFile(name) {
  return path.join(skillsDir(), name + '.md');
}

// ========== update 自动快照 ==========

test('updateSkill 自动把旧正文存入 versions 快照并更新 active.json', () => {
  const k = freshKnowledge();
  k.createSkill('sv', 'v1 正文');
  const res = k.updateSkill('sv', 'v2 正文');
  assert.strictEqual(res.success, true);
  // 新正文生效
  assert.strictEqual(k.readSkill('sv'), 'v2 正文');
  // 存在一个快照，内容为旧正文
  const versions = k.listSkillVersions('sv');
  assert.strictEqual(versions.length, 1);
  const snap = fs.readFileSync(path.join(versionsDir('sv'), versions[0].version + '.md'), 'utf-8');
  assert.strictEqual(snap, 'v1 正文');
  // active.json 记录 activeVersionId = 旧正文快照
  const act = JSON.parse(fs.readFileSync(activeFile('sv'), 'utf-8'));
  assert.strictEqual(act.activeVersionId, versions[0].version);
  assert.deepStrictEqual(act.history, [versions[0].version]);
});

test('createSkill 不产生版本快照（只有 update 才快照）', () => {
  const k = freshKnowledge();
  k.createSkill('sv2', 'body');
  assert.deepStrictEqual(k.listSkillVersions('sv2'), []);
  assert.ok(!fs.existsSync(activeFile('sv2')), '创建技能不应生成 active.json');
});

test('多次 update 累积多个快照，activeVersionId 为最近一次快照', () => {
  const k = freshKnowledge();
  k.createSkill('multi', 'A');
  k.updateSkill('multi', 'B'); // 快照 A
  k.updateSkill('multi', 'C'); // 快照 B
  const versions = k.listSkillVersions('multi');
  assert.strictEqual(versions.length, 2);
  const act = JSON.parse(fs.readFileSync(activeFile('multi'), 'utf-8'));
  assert.strictEqual(act.activeVersionId, versions[versions.length - 1].version);
  assert.strictEqual(act.history.length, 2);
});

// ========== listSkillVersions ==========

test('listSkillVersions 返回时间戳+摘要，且标记 active', () => {
  const k = freshKnowledge();
  k.createSkill('ls', '第一行摘要\n第二行');
  k.updateSkill('ls', '新正文');
  const versions = k.listSkillVersions('ls');
  assert.strictEqual(versions.length, 1);
  const v = versions[0];
  assert.ok(/^[0-9]+$/.test(v.version), 'version 应为数字时间戳');
  assert.match(v.summary, /第一行摘要/);
  assert.strictEqual(v.active, true, '旧正文快照即当前 active');
  assert.strictEqual(typeof v.mtime, 'number');
});

test('listSkillVersions 对未知技能返回空数组', () => {
  const k = freshKnowledge();
  assert.deepStrictEqual(k.listSkillVersions('ghost'), []);
});

test('listSkillVersions 对非法名返回空数组（防目录穿越）', () => {
  const k = freshKnowledge();
  for (const bad of ['', '../x', 'a/b', null, undefined]) {
    assert.deepStrictEqual(k.listSkillVersions(bad), []);
  }
});

// ========== restoreSkillVersion ==========

test('restoreSkillVersion 回退正文正确并更新 active.json', () => {
  const k = freshKnowledge();
  k.createSkill('rs', '原始正文');
  k.updateSkill('rs', '改后正文'); // 快照 = 原始正文
  const versions = k.listSkillVersions('rs');
  const oldVer = versions[0].version;
  const res = k.restoreSkillVersion('rs', oldVer);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.version, oldVer);
  // 正文回退
  assert.strictEqual(k.readSkill('rs'), '原始正文');
  // active.json 指向回退版本
  const act = JSON.parse(fs.readFileSync(activeFile('rs'), 'utf-8'));
  assert.strictEqual(act.activeVersionId, oldVer);
  // 列表中该版本标记为 active
  const after = k.listSkillVersions('rs');
  assert.strictEqual(after.find((x) => x.version === oldVer).active, true);
});

test('restoreSkillVersion 对不存在版本返回错误', () => {
  const k = freshKnowledge();
  k.createSkill('rs2', 'x');
  k.updateSkill('rs2', 'y');
  const res = k.restoreSkillVersion('rs2', '99999999999999');
  assert.strictEqual(res.success, false);
  assert.match(res.error, /不存在/);
});

test('restoreSkillVersion 对非法版本号返回错误（防目录穿越）', () => {
  const k = freshKnowledge();
  k.createSkill('rs3', 'x');
  for (const bad of ['../evil', 'a', '', null, undefined, '1/2']) {
    const res = k.restoreSkillVersion('rs3', bad);
    assert.strictEqual(res.success, false, '非法版本应失败: ' + String(bad));
  }
});

test('restoreSkillVersion 对非法技能名返回错误', () => {
  const k = freshKnowledge();
  const res = k.restoreSkillVersion('../evil', '1');
  assert.strictEqual(res.success, false);
  assert.match(res.error, /非法/);
});

// ========== 保留 20 个上限 ==========

test('版本保留最近 20 个，超出清理最旧', () => {
  const k = freshKnowledge();
  k.createSkill('cap', 'v0');
  // 做 25 次更新 → 产生 25 个快照，应只保留最近 20 个
  for (let i = 1; i <= 25; i++) {
    const r = k.updateSkill('cap', 'v' + i);
    assert.strictEqual(r.success, true);
  }
  const versions = k.listSkillVersions('cap');
  assert.strictEqual(versions.length, 20, '应只保留最近 20 个快照');
  const act = JSON.parse(fs.readFileSync(activeFile('cap'), 'utf-8'));
  assert.strictEqual(act.history.length, 20);
  // 磁盘上也应只剩 20 个快照文件
  const files = fs.readdirSync(versionsDir('cap')).filter((f) => f.endsWith('.md'));
  assert.strictEqual(files.length, 20);
  // 最早的快照应是 v5（前 5 个 v1..v4 及 v0 已被清理；每次 update 快照的是"更新前正文"）
  // 说明：update('v1') 快照 v0，update('v2') 快照 v1 ... update('v25') 快照 v24。
  // 共 25 个快照 v0..v24，保留最近 20 个 = v5..v24。
  const earliest = fs.readFileSync(path.join(versionsDir('cap'), versions[0].version + '.md'), 'utf-8');
  assert.strictEqual(earliest, 'v5');
  const latest = fs.readFileSync(path.join(versionsDir('cap'), versions[19].version + '.md'), 'utf-8');
  assert.strictEqual(latest, 'v24');
});

// ========== 损坏 active.json 容错 ==========

test('active.json 损坏时 listSkillVersions 不抛错并备份', () => {
  const k = freshKnowledge();
  k.createSkill('corrupt', 'v1');
  k.updateSkill('corrupt', 'v2');
  // 破坏 active.json
  fs.writeFileSync(activeFile('corrupt'), '{ not json', 'utf-8');
  const versions = k.listSkillVersions('corrupt');
  assert.strictEqual(versions.length, 1, '快照文件仍在，应能列出');
  assert.strictEqual(versions[0].active, false, '损坏后 active 标记回落为 false');
  // 应生成损坏备份
  const dir = path.dirname(activeFile('corrupt'));
  const backups = fs.readdirSync(dir).filter((n) => n.startsWith('active.json.corrupt-'));
  assert.strictEqual(backups.length, 1, '应生成一个 active.json 损坏备份');
});

test('active.json 结构非法（history 非数组）时容错', () => {
  const k = freshKnowledge();
  k.createSkill('corrupt2', 'v1');
  k.updateSkill('corrupt2', 'v2');
  fs.writeFileSync(activeFile('corrupt2'), JSON.stringify({ activeVersionId: 1, history: 'oops' }), 'utf-8');
  const versions = k.listSkillVersions('corrupt2');
  assert.strictEqual(versions.length, 1);
  assert.strictEqual(versions[0].active, false);
});

test('active.json 缺失时不抛错（listSkillVersions 正常）', () => {
  const k = freshKnowledge();
  k.createSkill('missing', 'v1');
  k.updateSkill('missing', 'v2');
  try { fs.unlinkSync(activeFile('missing')); } catch (_) {}
  const versions = k.listSkillVersions('missing');
  assert.strictEqual(versions.length, 1);
  assert.strictEqual(versions[0].active, false);
});

test('updateSkill 只改 meta 不产生版本快照', () => {
  const k = freshKnowledge();
  k.createSkill('meta-only', 'body', { description: 'd1' });
  const res = k.updateSkill('meta-only', undefined, { description: 'd2' });
  assert.strictEqual(res.success, true);
  assert.deepStrictEqual(k.listSkillVersions('meta-only'), []);
  assert.ok(!fs.existsSync(activeFile('meta-only')));
});
