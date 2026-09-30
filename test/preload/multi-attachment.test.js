'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { readPendingAttachments } = require('../../src/preload/dom/chat-input');

// ============ 测试辅助 ============
// readPendingAttachments 依赖 findInputArea / isInTokFreeOverlay / isInputVisible / document。
// mock 策略：
//  - window.location.href 设为不匹配任何 provider 的 URL，使 getCurrentProvider() 返回 null，
//    findInputArea 退化为遍历 document.querySelectorAll('textarea')（返回空）→ null；
//    于是 railScope 为 null，扫描范围收敛为 document。
//  - document.querySelectorAll('img') 返回构造的图片数组；其它选择器返回空数组。
//  - 每个 img 提供 offsetWidth/offsetHeight/src/getAttribute('alt')/closest（closest 返回 null 表示不在覆盖层/消息区）。
// 这样只聚焦『图片逐张收集』这段逻辑。

function mkImg(opts) {
  opts = opts || {};
  return {
    src: opts.src || '',
    offsetWidth: opts.w === undefined ? 100 : opts.w,
    offsetHeight: opts.h === undefined ? 100 : opts.h,
    getAttribute: (k) => (k === 'alt' ? (opts.alt || '') : null),
    closest: () => null,
  };
}

function setDocument(imgs) {
  global.document = {
    querySelectorAll: (sel) => (sel === 'img' ? imgs : []),
    querySelector: () => null,
    getElementById: () => null,
  };
}

function setWindow() {
  global.window = { location: { href: 'https://example.com/not-a-provider' } };
}

// ============ 用例 ============

test('3 张不同的 blob 图 → 返回 3 条 image（不再合并为 1 条）', () => {
  setWindow();
  setDocument([
    mkImg({ src: 'blob:https://x/1' }),
    mkImg({ src: 'blob:https://x/2' }),
    mkImg({ src: 'blob:https://x/3' }),
  ]);
  const list = readPendingAttachments();
  const imgs = list.filter((a) => a.kind === 'image');
  assert.strictEqual(imgs.length, 3, '应逐张收集为 3 条');
  assert.deepStrictEqual(imgs.map((a) => a.name), ['图片', '图片2', '图片3']);
  assert.strictEqual(imgs[0].thumb, 'blob:https://x/1');
});

test('同 src 的图去重（2 个相同 blob src → 1 条）', () => {
  setWindow();
  setDocument([
    mkImg({ src: 'blob:https://x/same' }),
    mkImg({ src: 'blob:https://x/same' }),
  ]);
  const imgs = readPendingAttachments().filter((a) => a.kind === 'image');
  assert.strictEqual(imgs.length, 1);
});

test('<32px 的小图被过滤', () => {
  setWindow();
  setDocument([
    mkImg({ src: 'blob:https://x/big', w: 100, h: 100 }),
    mkImg({ src: 'blob:https://x/small', w: 16, h: 16 }),
  ]);
  const imgs = readPendingAttachments().filter((a) => a.kind === 'image');
  assert.strictEqual(imgs.length, 1);
  assert.strictEqual(imgs[0].thumb, 'blob:https://x/big');
});

test('data: 图片也被识别', () => {
  setWindow();
  setDocument([mkImg({ src: 'data:image/png;base64,AAAA' })]);
  const imgs = readPendingAttachments().filter((a) => a.kind === 'image');
  assert.strictEqual(imgs.length, 1);
  assert.strictEqual(imgs[0].thumb, 'data:image/png;base64,AAAA');
});

test('带文件名 alt 的图用 alt 作为 name', () => {
  setWindow();
  setDocument([mkImg({ src: 'blob:https://x/1', alt: 'screenshot.png' })]);
  const imgs = readPendingAttachments().filter((a) => a.kind === 'image');
  assert.strictEqual(imgs.length, 1);
  assert.strictEqual(imgs[0].name, 'screenshot.png');
});

test('非 blob/data 且无文件名 alt 的图被跳过', () => {
  setWindow();
  setDocument([
    mkImg({ src: 'https://cdn.example.com/deco.png', alt: '' }),
  ]);
  const imgs = readPendingAttachments().filter((a) => a.kind === 'image');
  assert.strictEqual(imgs.length, 0);
});
