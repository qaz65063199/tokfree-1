'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSessionStore } = require('../../src/main/session-store');

// 聚焦：会话别名（重命名）为【全局共享】——不同 profile 的 store 读写同一份
// session-alias-global.json，从而让"重命名"在所有窗口同步。
// （rename-session 的 IPC 广播在 ipc.js 中，依赖 windowState 多上下文 mock，较复杂，
//  本文件聚焦 session-store 的全局共享这一可判定核心。）

const tmpDir = path.join(process.cwd(), 'test', 'tmp', 'rename-broadcast-test');

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

test('别名全局共享：s1 写，s2 立即可读', () => {
  const s1 = makeStore('p1');
  const s2 = makeStore('p2');
  s1.saveAlias('x', 'A');
  assert.strictEqual(s2.getAliases()['x'], 'A', 'p2 应读到 p1 保存的全局别名');
});

test('别名全局共享：s2 覆盖后 s1 可见（双向同步）', () => {
  const s1 = makeStore('p1');
  const s2 = makeStore('p2');
  s1.saveAlias('x', 'A');
  s2.saveAlias('x', 'B');
  assert.strictEqual(s1.getAliases()['x'], 'B', 'p1 应读到 p2 覆盖后的全局别名');
});

test('全局别名文件名不含 profileId', () => {
  const s1 = makeStore('p1');
  s1.saveAlias('x', 'A');
  assert.ok(
    fs.existsSync(path.join(tmpDir, 'session-alias-global.json')),
    '应写入全局别名文件 session-alias-global.json'
  );
  assert.ok(
    !fs.existsSync(path.join(tmpDir, 'session-alias-p1.json')),
    '不应再写入每 profile 独立的旧别名文件'
  );
});

test('别名清除也全局生效', () => {
  const s1 = makeStore('p1');
  const s2 = makeStore('p2');
  s1.saveAlias('x', 'A');
  s2.saveAlias('x', '');
  assert.strictEqual(s1.getAliases()['x'], undefined, '清除应全局生效');
});

test('别名跨新实例持久化（全局文件已落盘）', () => {
  const s1 = makeStore('p1');
  s1.saveAlias('x', 'A');
  const s3 = makeStore('p3');
  assert.strictEqual(s3.getAliases()['x'], 'A', '全新实例应读到已落盘的全局别名');
});
