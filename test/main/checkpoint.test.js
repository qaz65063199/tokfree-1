'use strict';
/**
 * checkpoint.js 单元测试
 * 快照存储（userData/checkpoints/）+ 回滚 + 上限清理。
 * 用临时目录作为 baseDir，不依赖 electron。
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CheckpointStore } = require('../../src/main/checkpoint');

let tmpDir;
let store;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-ckpt-'));
  store = new CheckpointStore({ baseDir: tmpDir });
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

test('save 保存快照并返回 id', () => {
  const r = store.save({ filePath: '/x/a.js', content: 'old', operation: 'edit' });
  assert.strictEqual(r.success, true);
  assert.ok(r.id);
  const list = store.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].filePath, '/x/a.js');
  assert.strictEqual(list[0].content, 'old');
  assert.strictEqual(list[0].operation, 'edit');
});

test('list 按时间倒序', () => {
  store.save({ filePath: '/x/a.js', content: '1', operation: 'edit' });
  store.save({ filePath: '/x/b.js', content: '2', operation: 'write' });
  const list = store.list();
  assert.strictEqual(list.length, 2);
  assert.ok(list[0].createdAt >= list[1].createdAt);
});

test('get 读取快照详情，不存在返回 null', () => {
  const r = store.save({ filePath: '/x/a.js', content: 'old', operation: 'edit' });
  const rec = store.get(r.id);
  assert.strictEqual(rec.content, 'old');
  assert.strictEqual(store.get('nope'), null);
});

test('restore 把旧内容写回文件', () => {
  const f = path.join(tmpDir, 'target.js');
  fs.writeFileSync(f, 'modified', 'utf-8');
  const r = store.save({ filePath: f, content: 'original', operation: 'edit' });
  fs.writeFileSync(f, 'changed-again', 'utf-8');
  const res = store.restore(r.id);
  assert.strictEqual(res.success, true);
  assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'original');
});

test('restore 不存在快照返回失败', () => {
  const res = store.restore('ghost');
  assert.strictEqual(res.success, false);
  assert.match(res.error, /not found/);
});

test('restore 回滚前会再存一份当前内容', () => {
  const f = path.join(tmpDir, 'target.js');
  fs.writeFileSync(f, 'v1', 'utf-8');
  const r1 = store.save({ filePath: f, content: 'v0', operation: 'edit' });
  fs.writeFileSync(f, 'v2', 'utf-8');
  store.restore(r1.id);
  // 回滚后应至少有：原始快照 + restore-backup 快照
  const list = store.list();
  assert.ok(list.some((x) => x.operation === 'restore-backup'));
});

test('remove 删除快照', () => {
  const r = store.save({ filePath: '/x/a.js', content: 'old', operation: 'edit' });
  const res = store.remove(r.id);
  assert.strictEqual(res.success, true);
  assert.strictEqual(store.list().length, 0);
});

test('数量超过上限时淘汰最旧', () => {
  const s = new CheckpointStore({ baseDir: tmpDir, maxSnapshots: 3, maxBytes: 1e9 });
  for (let i = 0; i < 6; i++) s.save({ filePath: '/x/f' + i, content: 'c' + i, operation: 'edit' });
  assert.strictEqual(s.list().length, 3);
  // 最新的 f5 应保留
  assert.ok(s.list().some((r) => r.filePath === '/x/f5'));
  // 最旧的 f0 应被淘汰
  assert.ok(!s.list().some((r) => r.filePath === '/x/f0'));
});

test('delete 快照 content 为 null（不可恢复内容）', () => {
  const r = store.save({ filePath: '/x/gone.js', content: null, operation: 'delete', deleted: true });
  const rec = store.get(r.id);
  assert.strictEqual(rec.deleted, true);
  assert.strictEqual(rec.content, null);
});
