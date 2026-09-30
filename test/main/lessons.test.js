'use strict';
/**
 * lessons.js 单元测试
 *
 * lessons.js 依赖 electron 的 app.getPath('userData') 定位存储目录。
 * 参照 test/main/knowledge.test.js 的做法，用 Module._load 钩子 mock electron，
 * 把 userData 指向临时目录，隔离文件系统副作用。
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
          getPath: () => userDataDir,
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

function freshLessons() {
  delete require.cache[require.resolve('../../src/main/lessons')];
  return require('../../src/main/lessons');
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-lessons-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-proj-'));
  installMock();
});

afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/lessons')];
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch (_) {}
});

function lessonsFile() {
  return path.join(userDataDir, 'knowledge', 'lessons.json');
}

function corruptBackups(file) {
  const dir = path.dirname(file);
  const base = path.basename(file) + '.corrupt-';
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.startsWith(base));
}

// ========== recordLesson ==========

test('recordLesson 成功记录并返回 id 且落盘', () => {
  const L = freshLessons();
  const res = L.recordLesson({ lesson: '别用 tabs', context: '任务A', tags: ['style'] });
  assert.strictEqual(res.success, true);
  assert.ok(res.id && res.id.startsWith('lsn-'), 'id 应以 lsn- 开头');
  assert.ok(fs.existsSync(lessonsFile()), 'lessons.json 应生成');
  const list = L.listLessons();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].lesson, '别用 tabs');
  assert.strictEqual(list[0].context, '任务A');
  assert.deepStrictEqual(list[0].tags, ['style']);
  assert.strictEqual(list[0].hits, 0);
  assert.strictEqual(list[0].scope, 'global'); // 未传 scope/projectDir 默认 global
  assert.ok(list[0].createdAt);
});

test('recordLesson 传 projectDir 时 scope 默认为该项目目录', () => {
  const L = freshLessons();
  L.recordLesson({ lesson: '本项目用 pnpm', projectDir });
  const item = L.listLessons()[0];
  assert.strictEqual(item.scope, projectDir);
  assert.strictEqual(item.projectDir, projectDir);
});

test('recordLesson 空 lesson 报错', () => {
  const L = freshLessons();
  for (const bad of [undefined, null, '', '   ']) {
    const res = L.recordLesson({ lesson: bad });
    assert.strictEqual(res.success, false, '空 lesson 应失败: ' + String(bad));
    assert.match(res.error, /lesson/);
  }
  assert.strictEqual(L.listLessons().length, 0);
});

// ========== listLessons / deleteLesson ==========

test('listLessons 返回全部教训', () => {
  const L = freshLessons();
  L.recordLesson({ lesson: 'a' });
  L.recordLesson({ lesson: 'b' });
  L.recordLesson({ lesson: 'c' });
  assert.strictEqual(L.listLessons().length, 3);
});

test('deleteLesson 删除指定教训', () => {
  const L = freshLessons();
  const id = L.recordLesson({ lesson: 'to-delete' }).id;
  const res = L.deleteLesson(id);
  assert.strictEqual(res.success, true);
  assert.strictEqual(L.listLessons().length, 0);
});

test('deleteLesson 不存在返回错误', () => {
  const L = freshLessons();
  const res = L.deleteLesson('ghost-id');
  assert.strictEqual(res.success, false);
  assert.match(res.error, /不存在/);
});

// ========== matchLessons ==========

test('matchLessons global 按 tags 匹配度排序', () => {
  const L = freshLessons();
  L.recordLesson({ lesson: '弱匹配', tags: ['react'] });
  L.recordLesson({ lesson: '强匹配', tags: ['react', 'vite'] });
  L.recordLesson({ lesson: '不匹配', tags: ['cooking'] });
  const res = L.matchLessons(null, ['react', 'vite']);
  assert.strictEqual(res.length, 2, '不匹配的 global 不返回');
  assert.strictEqual(res[0].lesson, '强匹配', '匹配度高的排在前');
  assert.strictEqual(res[1].lesson, '弱匹配');
});

test('matchLessons 项目教训全部纳入（无视关键词）', () => {
  const L = freshLessons();
  L.recordLesson({ lesson: '项目专属教训', projectDir });
  L.recordLesson({ lesson: '其他项目教训', projectDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-other-')) });
  const res = L.matchLessons(projectDir, []);
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].lesson, '项目专属教训');
});

test('matchLessons 返回结构含 id/lesson/context/tags/hits', () => {
  const L = freshLessons();
  L.recordLesson({ lesson: 'X', context: 'ctx', tags: ['t'] });
  const res = L.matchLessons(null, ['t']);
  assert.strictEqual(res.length, 1);
  assert.deepStrictEqual(Object.keys(res[0]).sort(), ['context', 'hits', 'id', 'lesson', 'tags']);
  assert.strictEqual(res[0].hits, 0);
});

test('matchLessons limit 限制 global 条数', () => {
  const L = freshLessons();
  for (let i = 0; i < 8; i++) L.recordLesson({ lesson: 'g' + i, tags: ['kw'] });
  const res = L.matchLessons(null, ['kw'], 3);
  assert.strictEqual(res.length, 3);
});

test('matchLessons 项目 + global 混合，项目在前', () => {
  const L = freshLessons();
  L.recordLesson({ lesson: '全局', tags: ['kw'] });
  L.recordLesson({ lesson: '项目', projectDir });
  const res = L.matchLessons(projectDir, ['kw']);
  assert.strictEqual(res.length, 2);
  assert.strictEqual(res[0].lesson, '项目');
  assert.strictEqual(res[1].lesson, '全局');
});

// ========== bumpHits ==========

test('bumpHits 命中计数 +1', () => {
  const L = freshLessons();
  const id = L.recordLesson({ lesson: 'hit me' }).id;
  const res = L.bumpHits([id]);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.updated, 1);
  assert.strictEqual(L.listLessons()[0].hits, 1);
  L.bumpHits([id]);
  assert.strictEqual(L.listLessons()[0].hits, 2);
});

test('bumpHits 忽略不存在的 id，空数组安全', () => {
  const L = freshLessons();
  L.recordLesson({ lesson: 'x' });
  assert.deepStrictEqual(L.bumpHits([]), { success: true, updated: 0 });
  assert.strictEqual(L.bumpHits(['nope']).updated, 0);
});

// ========== 淘汰 ==========

test('超过 200 条时淘汰 hits 低 + 最旧者', () => {
  const L = freshLessons();
  const ids = [];
  for (let i = 0; i < 205; i++) ids.push(L.recordLesson({ lesson: 'l' + i }).id);
  // 给最后 3 条增加 hits，使其免于淘汰
  L.bumpHits(ids.slice(202));
  const list = L.listLessons();
  assert.strictEqual(list.length, 200, '上限 200');
  // 无 hits 的最旧者（l0）应被淘汰
  assert.ok(!list.some((l) => l.lesson === 'l0'), 'hits 低的最旧者应被淘汰');
  assert.ok(list.some((l) => l.lesson === 'l204'), '有 hits 的保留');
});

// ========== 损坏容错 ==========

test('lessons.json 损坏（非法 JSON）返回空并备份', () => {
  const L = freshLessons();
  L.recordLesson({ lesson: 'a' }); // 先确保目录存在
  fs.writeFileSync(lessonsFile(), '{ this is not json', 'utf-8');
  assert.deepStrictEqual(L.listLessons(), []);
  const backups = corruptBackups(lessonsFile());
  assert.strictEqual(backups.length, 1, '应生成一个损坏备份');
  assert.strictEqual(
    fs.readFileSync(path.join(path.dirname(lessonsFile()), backups[0]), 'utf-8'),
    '{ this is not json'
  );
});

test('lessons.json 结构非法（lessons 非数组）返回空并备份', () => {
  const L = freshLessons();
  L.recordLesson({ lesson: 'a' });
  fs.writeFileSync(lessonsFile(), JSON.stringify({ lessons: 'oops' }), 'utf-8');
  assert.deepStrictEqual(L.listLessons(), []);
  assert.strictEqual(corruptBackups(lessonsFile()).length, 1);
});

test('文件正常时不产生损坏备份', () => {
  const L = freshLessons();
  L.recordLesson({ lesson: 'ok' });
  L.listLessons();
  assert.strictEqual(corruptBackups(lessonsFile()).length, 0);
});
