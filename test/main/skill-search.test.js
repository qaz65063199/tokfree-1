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
  Module._load = function (request) {
    if (request === 'electron') return { app: { getPath: () => tmpDir } };
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() { Module._load = origLoad; }
function fresh() {
  delete require.cache[require.resolve('../../src/main/knowledge')];
  return require('../../src/main/knowledge');
}

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-skillsearch-')); installMock(); });
afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/knowledge')];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

test('searchSkills 按英文关键词匹配', () => {
  const k = fresh();
  const pool = [
    { name: 'code-review', description: 'Review code quality and find bugs', tags: ['code', 'review'] },
    { name: 'party-report', description: 'Write party report', tags: ['report', 'writing'] },
  ];
  const hits = k.searchSkills('review my code', { pool: pool });
  assert.ok(hits.length >= 1);
  assert.strictEqual(hits[0].name, 'code-review');
});

test('searchSkills 中文 2-gram 匹配', () => {
  const k = fresh();
  const pool = [
    { name: 'party-report', description: '党建报告写作方法', tags: ['报告', '写作'] },
    { name: 'code-review', description: '代码审查', tags: ['代码'] },
  ];
  const hits = k.searchSkills('帮我写党建报告', { pool: pool });
  assert.ok(hits.some(function (h) { return h.name === 'party-report'; }));
});

test('searchSkills 空 query 返回空', () => {
  const k = fresh();
  assert.deepStrictEqual(k.searchSkills('', { pool: [{ name: 'x', description: 'y' }] }), []);
});

test('searchSkills 名称命中权重高于描述', () => {
  const k = fresh();
  const pool = [
    { name: 'auth-login', description: 'zzz', tags: [] },
    { name: 'other', description: 'auth login helper', tags: [] },
  ];
  const hits = k.searchSkills('auth login', { pool: pool });
  assert.strictEqual(hits[0].name, 'auth-login');
});

test('searchSkills limit 生效', () => {
  const k = fresh();
  const pool = [];
  for (let i = 0; i < 10; i++) pool.push({ name: 'skill-' + i, description: 'common word', tags: [] });
  const hits = k.searchSkills('common word', { pool: pool, limit: 3 });
  assert.strictEqual(hits.length, 3);
});
