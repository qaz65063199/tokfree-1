'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// 回归测试：findSendButton 返回覆盖层元素时必须拒绝点击。
// 背景 bug：DeepSeek provider 的 findSendButton 用 'button[title*="发送"]'，
// 会命中覆盖层「卡住了？点我」按钮（title 含"发送"），点击后触发"卡住催促"，
// 导致工具回执被覆盖、发不出去。修复：fallbackSend 用 isInTokFreeOverlay 排除。

test('isInTokFreeOverlay 识别覆盖层元素', () => {
  const { isInTokFreeOverlay } = require('../../src/preload/dom/chat-input');
  const overlayEl = { closest: (sel) => (sel.includes('tokfree') ? {} : null) };
  assert.strictEqual(isInTokFreeOverlay(overlayEl), true);
  const normalEl = { closest: () => null };
  assert.strictEqual(isInTokFreeOverlay(normalEl), false);
});

test('fallbackSend 拒绝点击覆盖层内的"发送"按钮', () => {
  // Node 环境无 KeyboardEvent（方法 2 的 Enter 兜底会用到），补一个最小桩
  global.KeyboardEvent = class { constructor() {} };
  const { fallbackSend } = require('../../src/preload/dom/chat-input');
  let clicked = false;
  // 模拟覆盖层里的「卡住了？点我」按钮：title 含"发送"，closest 命中覆盖层
  const overlayBtn = {
    click: () => { clicked = true; },
    closest: (sel) => (sel.includes('tokfree') ? {} : null),
    disabled: false,
    offsetWidth: 10,
    offsetHeight: 10,
  };
  const provider = { findSendButton: () => overlayBtn };
  // 传入 input，确保方法 2（Enter 兜底）不会抛错
  const input = { dispatchEvent: () => {} };
  fallbackSend(provider, input);
  assert.strictEqual(clicked, false, '不得点击覆盖层按钮');
});

test('fallbackSend 正常点击非覆盖层的发送按钮', () => {
  const { fallbackSend } = require('../../src/preload/dom/chat-input');
  let clicked = false;
  const realBtn = {
    click: () => { clicked = true; },
    closest: () => null,
    disabled: false,
    offsetWidth: 10,
    offsetHeight: 10,
  };
  const provider = { findSendButton: () => realBtn };
  fallbackSend(provider, null);
  assert.strictEqual(clicked, true, '应正常点击真实发送按钮');
});
