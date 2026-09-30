'use strict';
/**
 * report-queue.js 核心逻辑测试
 *
 * 重点回归「多 Agent 只能调动一次」的 bug：
 * isMasterIdle 在主大脑处于「完成确认」模式（mode='confirm'）时必须返回 true，
 * 否则回报永远投递不进去。
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const origLoad = Module._load;
let watchdogStatus = { profile: { expectingReply: false, busy: false, mode: 'idle' } };

function installMock() {
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => require('os').tmpdir() } };
    }
    if (request === '../watchdog' || request === './watchdog') {
      return { getStatus: () => watchdogStatus };
    }
    if (request === './task-manager' || request === '../task-manager') {
      return { getTask: () => null, listActiveTasks: () => [] };
    }
    if (request === '../window') {
      return { getMainContext: () => null, getWindowByProfileId: () => null, getAllContexts: () => [] };
    }
    if (request === '../profile-manager') {
      return { readProfiles: () => [] };
    }
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() { Module._load = origLoad; }

function fresh() {
  delete require.cache[require.resolve('../../src/main/team/report-queue')];
  return require('../../src/main/team/report-queue');
}

beforeEach(() => { installMock(); });
afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/team/report-queue')];
});

test('空闲(idle) → isMasterIdle=true', () => {
  const rq = fresh();
  watchdogStatus = { profile: { expectingReply: false, busy: false, mode: 'idle' } };
  assert.strictEqual(rq.isMasterIdle({ profileId: 'm1' }), true);
});

test('★回归：完成确认模式(confirm) → isMasterIdle=true（不再误判为忙）', () => {
  const rq = fresh();
  watchdogStatus = { profile: { expectingReply: true, busy: false, mode: 'confirm' } };
  assert.strictEqual(rq.isMasterIdle({ profileId: 'm1' }), true);
});

test('正在生成(expectingReply 且非 confirm) → isMasterIdle=false', () => {
  const rq = fresh();
  watchdogStatus = { profile: { expectingReply: true, busy: false, mode: 'interrupt' } };
  assert.strictEqual(rq.isMasterIdle({ profileId: 'm1' }), false);
});

test('长任务中(busy) → isMasterIdle=false', () => {
  const rq = fresh();
  watchdogStatus = { profile: { expectingReply: false, busy: true, mode: 'idle' } };
  assert.strictEqual(rq.isMasterIdle({ profileId: 'm1' }), false);
});

test('无 profile 状态 → isMasterIdle=true（不阻塞）', () => {
  const rq = fresh();
  watchdogStatus = { profile: null };
  assert.strictEqual(rq.isMasterIdle({ profileId: 'm1' }), true);
});
