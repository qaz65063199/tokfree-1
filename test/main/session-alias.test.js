'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSessionStore } = require('../../src/main/session-store');

const tmpDir = path.join(process.cwd(), 'test', 'tmp', 'session-alias-test');

beforeEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeStore(profileId = 'p1') {
  return createSessionStore(profileId, tmpDir, { getMainWindow: () => null });
}

test('初始无别名', () => {
  const store = makeStore();
  assert.deepStrictEqual(store.getAliases(), {});
});

test('saveAlias / getAliases 往返', () => {
  const store = makeStore();
  store.saveAlias('sess-1', '项目初始化检查');
  assert.strictEqual(store.getAliases()['sess-1'], '项目初始化检查');
});

test('别名去空格 + 超长截断（60 字符）', () => {
  const store = makeStore();
  store.saveAlias('sess-1', '  带空格  ');
  assert.strictEqual(store.getAliases()['sess-1'], '带空格');
  store.saveAlias('sess-2', 'x'.repeat(100));
  assert.strictEqual(store.getAliases()['sess-2'].length, 60);
});

test('空别名 = 清除（恢复显示会话 ID）', () => {
  const store = makeStore();
  store.saveAlias('sess-1', 'abc');
  store.saveAlias('sess-1', '');
  assert.strictEqual(store.getAliases()['sess-1'], undefined);
  store.saveAlias('sess-1', 'abc');
  store.saveAlias('sess-1', '   ');
  assert.strictEqual(store.getAliases()['sess-1'], undefined);
});

test('空 sessionId 不保存', () => {
  const store = makeStore();
  store.saveAlias('', 'abc');
  assert.deepStrictEqual(store.getAliases(), {});
});

test('别名持久化到独立文件，不侵入会话-目录映射', () => {
  const store = makeStore('p1');
  store.saveSessionDirMapping('sess-1', 'C:/proj');
  store.saveAlias('sess-1', '改名了');
  // 映射文件不含别名
  const mapRaw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'session-dir-map-p1.json'), 'utf-8'));
  assert.strictEqual(mapRaw['sess-1'], 'C:/proj');
  // 重新建实例仍能读到别名（已持久化）
  const store2 = makeStore('p1');
  assert.strictEqual(store2.getAliases()['sess-1'], '改名了');
});

test('别名全局共享（不同 profile 读同一份）', () => {
  const s1 = makeStore('p1');
  const s2 = makeStore('p2');
  s1.saveAlias('sess-1', 'A');
  assert.strictEqual(s2.getAliases()['sess-1'], 'A', 's2 应读到 s1 保存的全局别名');
  s2.saveAlias('sess-1', 'B');
  assert.strictEqual(s1.getAliases()['sess-1'], 'B', 's1 应读到 s2 覆盖后的全局别名');
});

test('别名文件损坏时回退空对象', () => {
  fs.writeFileSync(path.join(tmpDir, 'session-alias-global.json'), '{{{bad json', 'utf-8');
  const store = makeStore('p1');
  assert.deepStrictEqual(store.getAliases(), {});
});
