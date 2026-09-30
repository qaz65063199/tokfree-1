'use strict';
/**
 * window-bounds.js 单元测试
 *
 * window-bounds.js 依赖 electron 的 app.getPath('userData') 定位存储文件。
 * 用 Module._load 钩子 mock electron，把 userData 指向临时目录，隔离文件系统副作用。
 * 模块内部对存储文件路径有缓存，每个测试需清除 require 缓存后重新 require。
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

function fresh() {
  delete require.cache[require.resolve('../../src/main/window-bounds')];
  return require('../../src/main/window-bounds');
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-wb-'));
  installMock();
});
afterEach(() => {
  uninstallMock();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
});

test('load 无记录返回 null', () => {
  const wb = fresh();
  assert.strictEqual(wb.load('p1'), null);
});

test('save 后 load 可读回', () => {
  const wb = fresh();
  wb.save('p1', { x: 10, y: 20, width: 800, height: 600, maximized: true });
  const b = wb.load('p1');
  assert.strictEqual(b.x, 10);
  assert.strictEqual(b.y, 20);
  assert.strictEqual(b.width, 800);
  assert.strictEqual(b.height, 600);
  assert.strictEqual(b.maximized, true);
});

test('save 不同 key 互不干扰', () => {
  const wb = fresh();
  wb.save('p1', { x: 1, y: 1, width: 100, height: 100, maximized: false });
  wb.save('__shell__', { x: 2, y: 2, width: 200, height: 200, maximized: true });
  assert.strictEqual(wb.load('p1').width, 100);
  assert.strictEqual(wb.load('__shell__').width, 200);
});

test('持久化：新实例可读到已有记录', () => {
  let wb = fresh();
  wb.save('p1', { x: 5, y: 6, width: 700, height: 500, maximized: false });
  wb = fresh();
  const b = wb.load('p1');
  assert.strictEqual(b.width, 700);
  assert.strictEqual(b.maximized, false);
});

test('capture 从窗口抓取 bounds + maximized', () => {
  const wb = fresh();
  const fakeWin = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 3, y: 4, width: 640, height: 480 }),
    isMaximized: () => true,
  };
  const b = wb.capture(fakeWin);
  assert.strictEqual(b.width, 640);
  assert.strictEqual(b.height, 480);
  assert.strictEqual(b.maximized, true);
});

test('capture 已销毁窗口返回 null', () => {
  const wb = fresh();
  assert.strictEqual(wb.capture({ isDestroyed: () => true }), null);
});

test('apply 无记录返回 null 且不 setBounds', () => {
  const wb = fresh();
  let called = false;
  const fakeWin = { setBounds: () => { called = true; } };
  assert.strictEqual(wb.apply(fakeWin, 'p1'), null);
  assert.strictEqual(called, false);
});

test('apply 有记录时 setBounds 并返回 maximized', () => {
  const wb = fresh();
  wb.save('p1', { x: 10, y: 20, width: 800, height: 600, maximized: false });
  let got = null;
  const fakeWin = { setBounds: (b) => { got = b; } };
  assert.strictEqual(wb.apply(fakeWin, 'p1'), false);
  assert.strictEqual(got.width, 800);
  assert.strictEqual(got.height, 600);
});

test('损坏 JSON 容错：load 返回 null', () => {
  fs.writeFileSync(path.join(userDataDir, 'window-bounds.json'), '{bad json', 'utf-8');
  const wb = fresh();
  assert.strictEqual(wb.load('p1'), null);
});
