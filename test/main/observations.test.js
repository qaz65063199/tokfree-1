'use strict';
/**
 * observations.js 单元测试
 *
 * observations.js 依赖 electron 的 app.getPath('userData') 定位存储目录。
 * 参照 test/main/lessons.test.js 的做法，用 Module._load 钩子 mock electron，
 * 把 userData 指向临时目录，隔离文件系统副作用。
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

function freshObs() {
  delete require.cache[require.resolve('../../src/main/observations')];
  return require('../../src/main/observations');
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-obs-'));
  installMock();
});

afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/observations')];
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
});

function obsFile(profileId) {
  const safe = String(profileId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
  return path.join(userDataDir, 'observations', safe + '.json');
}

function corruptBackups(file) {
  const dir = path.dirname(file);
  const base = path.basename(file) + '.corrupt-';
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.startsWith(base));
}

// ========== addObservation / listObservations ==========

test('addObservation 成功记录并落盘（含 id/category/summary/source/ts）', () => {
  const O = freshObs();
  const res = O.addObservation('p1', { category: '决策', summary: '用 SQLite', source: '会话1' });
  assert.strictEqual(res.success, true);
  assert.ok(res.id && res.id.startsWith('obs-'), 'id 应以 obs- 开头');
  assert.ok(fs.existsSync(obsFile('p1')), 'observations/<p1>.json 应生成');
  const list = O.listObservations('p1', 10);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].category, '决策');
  assert.strictEqual(list[0].summary, '用 SQLite');
  assert.strictEqual(list[0].source, '会话1');
  assert.ok(list[0].ts);
});

test('addObservation 非法 category 报错', () => {
  const O = freshObs();
  const res = O.addObservation('p1', { category: '随便', summary: 'x' });
  assert.strictEqual(res.success, false);
  assert.match(res.error, /category/);
  assert.strictEqual(O.listObservations('p1', 10).length, 0);
});

test('addObservation 空 summary 报错', () => {
  const O = freshObs();
  for (const bad of [undefined, null, '', '   ']) {
    const res = O.addObservation('p1', { category: '偏好', summary: bad });
    assert.strictEqual(res.success, false, '空 summary 应失败: ' + String(bad));
    assert.match(res.error, /summary/);
  }
});

test('listObservations 按时间升序返回最近 N 条', () => {
  const O = freshObs();
  for (let i = 0; i < 5; i++) O.addObservation('p1', { category: '上下文', summary: 's' + i });
  const all = O.listObservations('p1', 10);
  assert.strictEqual(all.length, 5);
  assert.strictEqual(all[0].summary, 's0');
  assert.strictEqual(all[4].summary, 's4');
  const last3 = O.listObservations('p1', 3);
  assert.strictEqual(last3.length, 3);
  assert.strictEqual(last3[0].summary, 's2');
  assert.strictEqual(last3[2].summary, 's4');
});

test('不同 profileId 存储隔离', () => {
  const O = freshObs();
  O.addObservation('p1', { category: '决策', summary: 'p1 的观察' });
  O.addObservation('p2', { category: '决策', summary: 'p2 的观察' });
  assert.strictEqual(O.listObservations('p1', 10).length, 1);
  assert.strictEqual(O.listObservations('p1', 10)[0].summary, 'p1 的观察');
  assert.strictEqual(O.listObservations('p2', 10)[0].summary, 'p2 的观察');
});

// ========== parseObservations ==========

test('parseObservations 提取 observation 块（含 category/summary/source）', () => {
  const O = freshObs();
  const text = [
    '一些说明',
    '<observation>',
    'category: 踩坑',
    'summary: React setState 异步',
    'source: 任务3',
    '</observation>',
    '结束',
  ].join('\n');
  const res = O.parseObservations(text);
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].category, '踩坑');
  assert.strictEqual(res[0].summary, 'React setState 异步');
  assert.strictEqual(res[0].source, '任务3');
});

test('parseObservations 支持标签形式字段', () => {
  const O = freshObs();
  const text = '<observation><category>待办</category><summary>补测试</summary><source>自我</source></observation>';
  const res = O.parseObservations(text);
  assert.strictEqual(res.length, 1);
  assert.deepStrictEqual(res[0], { category: '待办', summary: '补测试', source: '自我' });
});

test('parseObservations 剔除 Markdown 代码围栏（不误抓示例）', () => {
  const O = freshObs();
  const fence = String.fromCharCode(96).repeat(3);
  const text = [
    fence + 'js',
    '<observation>',
    'category: 决策',
    'summary: 这是代码里的示例不应被抓到',
    '</observation>',
    fence,
    '<observation>',
    'category: 偏好',
    'summary: 真实观察',
    '</observation>',
  ].join('\n');
  const res = O.parseObservations(text);
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].summary, '真实观察');
});

test('parseObservations 缺字段的块被跳过；非字符串输入返回空数组', () => {
  const O = freshObs();
  const text = '<observation><summary>缺 category</summary></observation>';
  assert.deepStrictEqual(O.parseObservations(text), []);
  assert.deepStrictEqual(O.parseObservations(null), []);
  assert.deepStrictEqual(O.parseObservations(''), []);
});

// ========== reflection ==========

test('addReflection / listReflections 正常工作', () => {
  const O = freshObs();
  const r1 = O.addReflection('p1', '本项目偏好函数式写法');
  assert.strictEqual(r1.success, true);
  assert.ok(r1.id && r1.id.startsWith('ref-'));
  const r2 = O.addReflection('p1', '踩坑：并发写同一文件冲突');
  assert.strictEqual(r2.success, true);
  const list = O.listReflections('p1');
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].summary, '本项目偏好函数式写法');
});

test('addReflection 空 summary 报错', () => {
  const O = freshObs();
  const res = O.addReflection('p1', '   ');
  assert.strictEqual(res.success, false);
  assert.match(res.error, /summary/);
});

// ========== mergeObservations（阈值触发） ==========

test('mergeObservations 未达阈值时返回 needsMerge:false', () => {
  const O = freshObs();
  for (let i = 0; i < 5; i++) O.addObservation('p1', { category: '决策', summary: 's' + i });
  const res = O.mergeObservations('p1');
  assert.strictEqual(res.merged, false);
  assert.strictEqual(res.needsMerge, false);
  assert.strictEqual(res.count, 5);
});

test('mergeObservations 达阈值无回调时返回 needsMerge 信号 + 待合并内容', () => {
  const O = freshObs();
  for (let i = 0; i < O.DEFAULT_MERGE_THRESHOLD; i++) {
    O.addObservation('p1', { category: '决策', summary: 's' + i });
  }
  const res = O.mergeObservations('p1');
  assert.strictEqual(res.needsMerge, true);
  assert.strictEqual(res.count, O.DEFAULT_MERGE_THRESHOLD);
  assert.strictEqual(res.observations.length, O.DEFAULT_MERGE_THRESHOLD);
  // 未真正合并，observations 仍在
  assert.strictEqual(O.listObservations('p1', 100).length, O.DEFAULT_MERGE_THRESHOLD);
});

test('mergeObservations 传 aiMerge 回调时执行合并并清空 observations', () => {
  const O = freshObs();
  for (let i = 0; i < O.DEFAULT_MERGE_THRESHOLD; i++) {
    O.addObservation('p1', { category: '决策', summary: 's' + i });
  }
  const aiMerge = () => '<reflection><summary>合并后的结论A</summary></reflection>\n<reflection>合并后的结论B</reflection>';
  const res = O.mergeObservations('p1', aiMerge);
  assert.strictEqual(res.merged, true);
  assert.strictEqual(res.added, 2);
  assert.deepStrictEqual(res.reflections, ['合并后的结论A', '合并后的结论B']);
  // observations 被吸收清空
  assert.strictEqual(O.listObservations('p1', 100).length, 0);
  // reflections 落盘
  const refs = O.listReflections('p1');
  assert.strictEqual(refs.length, 2);
  assert.strictEqual(refs[0].summary, '合并后的结论A');
});

test('mergeObservations aiMerge 返回空时合并失败且数据保留', () => {
  const O = freshObs();
  for (let i = 0; i < O.DEFAULT_MERGE_THRESHOLD; i++) {
    O.addObservation('p1', { category: '决策', summary: 's' + i });
  }
  const res = O.mergeObservations('p1', () => '没有 reflection 标签');
  assert.strictEqual(res.merged, false);
  assert.match(res.error, /reflection/);
  assert.strictEqual(O.listObservations('p1', 100).length, O.DEFAULT_MERGE_THRESHOLD);
});

// ========== 上限清理 ==========

test('observations 超过 50 条时清理最旧', () => {
  const O = freshObs();
  for (let i = 0; i < 60; i++) O.addObservation('p1', { category: '上下文', summary: 's' + i });
  const list = O.listObservations('p1', 1000);
  assert.strictEqual(list.length, O.MAX_OBSERVATIONS, 'observations 上限 ' + O.MAX_OBSERVATIONS);
  assert.ok(!list.some((o) => o.summary === 's0'), '最旧的应被淘汰');
  assert.ok(list.some((o) => o.summary === 's59'), '最新的保留');
});

test('reflections 超过 20 条时清理最旧', () => {
  const O = freshObs();
  for (let i = 0; i < 25; i++) O.addReflection('p1', 'r' + i);
  const list = O.listReflections('p1');
  assert.strictEqual(list.length, O.MAX_REFLECTIONS, 'reflections 上限 ' + O.MAX_REFLECTIONS);
  assert.ok(!list.some((r) => r.summary === 'r0'), '最旧的应被淘汰');
  assert.ok(list.some((r) => r.summary === 'r24'), '最新的保留');
});

// ========== 损坏容错 ==========

test('observations 文件损坏（非法 JSON）返回空并备份', () => {
  const O = freshObs();
  O.addObservation('p1', { category: '决策', summary: 'a' });
  fs.writeFileSync(obsFile('p1'), '{ this is not json', 'utf-8');
  assert.deepStrictEqual(O.listObservations('p1', 10), []);
  assert.deepStrictEqual(O.listReflections('p1'), []);
  const backups = corruptBackups(obsFile('p1'));
  assert.strictEqual(backups.length, 1, '应生成一个损坏备份');
});

test('observations 文件结构非法（observations 非数组）返回空并备份', () => {
  const O = freshObs();
  O.addObservation('p1', { category: '决策', summary: 'a' });
  fs.writeFileSync(obsFile('p1'), JSON.stringify({ observations: 'oops', reflections: [] }), 'utf-8');
  assert.deepStrictEqual(O.listObservations('p1', 10), []);
  assert.strictEqual(corruptBackups(obsFile('p1')).length, 1);
});

test('文件正常时不产生损坏备份', () => {
  const O = freshObs();
  O.addObservation('p1', { category: '决策', summary: 'ok' });
  O.listObservations('p1', 10);
  assert.strictEqual(corruptBackups(obsFile('p1')).length, 0);
});
