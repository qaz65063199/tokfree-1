'use strict';

/**
 * 壳标签收口回归测试（window.js 的 getShellWindow / openProfileAsTab）
 * 覆盖：无壳窗口时回退 false；有壳窗口时发送 shell-open-tab 事件（open / replace）。
 * 说明：window.js 不直接依赖 electron，可用普通对象模拟壳窗口。
 */
const test = require('node:test');
const assert = require('node:assert');

const ws = require('../../src/main/window');

/** 构造一个模拟壳窗口（记录发送的事件，after 后注销） */
function mockShellWindow(t, sent) {
  const win = {
    id: 900001,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => {},
    focus: () => {},
    on: () => {},
    webContents: {
      send: (channel, payload) => { sent.push({ channel, payload }); },
    },
  };
  ws.registerShellWindow(win);
  t.after(() => {
    // 模拟壳窗口关闭：触发 getShellWindow 的 destroyed 分支
    win.isDestroyed = () => true;
  });
  return win;
}

const PROFILE = {
  id: 'profile-123-abc',
  providerId: 'deepseek',
  name: '标签2',
  partition: 'persist:deepseek:profile-123-abc',
};

test('无壳窗口时 openProfileAsTab 返回 false（调用方回退 createWindow）', () => {
  // 确保没有活跃壳窗口（前序用例注销后 isDestroyed=true 视为无壳）
  const r = ws.openProfileAsTab(PROFILE);
  assert.equal(r, false);
});

test('有壳窗口时发送 shell-open-tab(open) 并返回 true', (t) => {
  const sent = [];
  mockShellWindow(t, sent);
  const r = ws.openProfileAsTab(PROFILE);
  assert.equal(r, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, 'shell-open-tab');
  assert.equal(sent[0].payload.type, 'open');
  assert.equal(sent[0].payload.profileId, PROFILE.id);
  assert.equal(sent[0].payload.partition, PROFILE.partition);
  assert.ok(sent[0].payload.url.includes('deepseek'));
});

test('replace 模式发送 shell-open-tab(replace)', (t) => {
  const sent = [];
  mockShellWindow(t, sent);
  const r = ws.openProfileAsTab(PROFILE, { replace: true });
  assert.equal(r, true);
  assert.equal(sent[0].payload.type, 'replace');
});

test('profile 缺 id 时返回 false', (t) => {
  const sent = [];
  mockShellWindow(t, sent);
  assert.equal(ws.openProfileAsTab({ name: 'x' }), false);
  assert.equal(ws.openProfileAsTab(null), false);
  assert.equal(sent.length, 0);
});

test('壳窗口已销毁时 getShellWindow 返回 null、openProfileAsTab 返回 false', (t) => {
  const sent = [];
  const win = mockShellWindow(t, sent);
  win.isDestroyed = () => true; // 立即销毁
  assert.equal(ws.getShellWindow(), null);
  assert.equal(ws.openProfileAsTab(PROFILE), false);
  assert.equal(sent.length, 0);
});
