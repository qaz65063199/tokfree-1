'use strict';
/**
 * self-loop-driver.onTurnEnd 单元测试 —— 回合结束延迟复查路径
 *
 * 注意：onTurnEnd 已从「同步注入」改为「延迟复查」（默认 15s 后触发）。
 * 测试中把 CONFIG.turnEndDelayMs 调小（40ms）并 await 等待定时器触发，
 * 以验证注入判断逻辑本身仍然正确。
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const origLoad = Module._load;
let tmpDir;
let mock; // 各依赖的可控替身
let drv;

function installMock() {
  Module._load = function (request) {
    if (request === 'electron') return { app: { getPath: () => tmpDir } };
    if (request === '../../core/agent-runtime/inject' || request.endsWith('agent-runtime/inject')) {
      return { inject: (profileId, message) => { mock.injects.push({ profileId, message }); return true; } };
    }
    if (request.endsWith('agent-runtime/paths')) {
      return { getBaseDir: () => tmpDir };
    }
    if (request === './self-loop') return mock.selfLoop;
    if (request === './self-loop-guard') return mock.guard;
    if (request === './evolution-switch') return mock.evolutionSwitch;
    if (request === './master-activity') return mock.masterActivity;
    if (request === '../window') return mock.windowState;
    if (request === '../watchdog') return mock.watchdog;
    if (request === './task-manager') return { isWorkerProfile: () => false };
    if (request === '../profile-manager') return { getProfileById: () => null };
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() { Module._load = origLoad; }

function freshDriver() {
  delete require.cache[require.resolve('../../src/main/team/self-loop-driver')];
  return require('../../src/main/team/self-loop-driver');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-turnend-'));
  mock = {
    injects: [],
    selfLoop: {
      listGoals: () => [],
      listRunningGoals: () => [],
      decideNextAction: () => ({ action: 'execute', payload: {} }),
      buildNextRoundPrompt: () => 'NEXT_ROUND_PROMPT',
      abortGoal: () => ({ success: true }),
    },
    guard: {
      checkGoalHealth: () => ({ action: 'continue', issues: [] }),
      canInject: () => ({ allowed: true }),
      recordInject: () => {},
    },
    evolutionSwitch: { isEnabled: () => true },
    masterActivity: { noteInject: () => {} },
    windowState: {
      getMainContext: () => ({ profileId: 'main', win: { isDestroyed: () => false } }),
      getWindowByProfileId: (pid) => (pid === 'p1' ? { profileId: 'p1', win: { isDestroyed: () => false } } : null),
    },
    watchdog: { getStatus: () => ({ profile: { busy: false } }) },
  };
  installMock();
});
afterEach(() => {
  try { if (drv && drv.stop) drv.stop(); } catch (_) {}
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/team/self-loop-driver')];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

test('onTurnEnd：有该窗口的 running goal → 延迟后触发注入', async () => {
  mock.selfLoop.listRunningGoals = () => [{ id: 'g1', profileId: 'p1', round: 0, status: 'running' }];
  drv = freshDriver();
  drv.CONFIG.turnEndDelayMs = 40; drv.CONFIG.quietSecs = 0;
  drv.onTurnEnd('p1');
  await sleep(120);
  assert.strictEqual(mock.injects.length, 1, '应注入一次');
  assert.strictEqual(mock.injects[0].profileId, 'p1');
});

test('onTurnEnd：无 running goal → 不注入', async () => {
  mock.selfLoop.listRunningGoals = () => [];
  drv = freshDriver();
  drv.CONFIG.turnEndDelayMs = 40; drv.CONFIG.quietSecs = 0;
  drv.onTurnEnd('p1');
  await sleep(120);
  assert.strictEqual(mock.injects.length, 0);
});

test('onTurnEnd：延迟窗口内二次回合 → 只注入一次（定时器重置）', async () => {
  mock.selfLoop.listRunningGoals = () => [{ id: 'g1', profileId: 'p1', round: 0, status: 'running' }];
  drv = freshDriver();
  drv.CONFIG.turnEndDelayMs = 60; drv.CONFIG.quietSecs = 0;
  drv.onTurnEnd('p1');
  drv.onTurnEnd('p1');
  await sleep(160);
  assert.strictEqual(mock.injects.length, 1, '两次回合结束只保留最新定时器，注入一次');
});

test('onTurnEnd：goal 已达标（decideNextAction=done）→ 不注入', async () => {
  mock.selfLoop.listRunningGoals = () => [{ id: 'g1', profileId: 'p1', round: 1, status: 'running' }];
  mock.selfLoop.decideNextAction = () => ({ action: 'done', payload: {} });
  drv = freshDriver();
  drv.CONFIG.turnEndDelayMs = 40; drv.CONFIG.quietSecs = 0;
  drv.onTurnEnd('p1');
  await sleep(120);
  assert.strictEqual(mock.injects.length, 0);
});

test('onTurnEnd：goal 属于其他窗口 → 不注入', async () => {
  mock.selfLoop.listRunningGoals = () => [{ id: 'g2', profileId: 'other', round: 0, status: 'running' }];
  drv = freshDriver();
  drv.CONFIG.turnEndDelayMs = 40; drv.CONFIG.quietSecs = 0;
  drv.onTurnEnd('p1');
  await sleep(120);
  assert.strictEqual(mock.injects.length, 0);
});

test('onTurnEnd：无归属 goal → 仅主窗口处理，非主窗口不注入', async () => {
  mock.selfLoop.listRunningGoals = () => [{ id: 'g3', profileId: '', round: 0, status: 'running' }];
  drv = freshDriver();
  drv.CONFIG.turnEndDelayMs = 40; drv.CONFIG.quietSecs = 0;
  drv.onTurnEnd('p1');
  await sleep(100);
  assert.strictEqual(mock.injects.length, 0, '非主窗口不应处理无归属 goal');
  drv.onTurnEnd('main');
  await sleep(100);
  assert.strictEqual(mock.injects.length, 1, '主窗口应处理无归属 goal');
});

test('onTurnEnd：总开关关闭 → 不注入', async () => {
  mock.evolutionSwitch.isEnabled = () => false;
  mock.selfLoop.listRunningGoals = () => [{ id: 'g1', profileId: 'p1', round: 0, status: 'running' }];
  drv = freshDriver();
  drv.CONFIG.turnEndDelayMs = 40; drv.CONFIG.quietSecs = 0;
  drv.onTurnEnd('p1');
  await sleep(120);
  assert.strictEqual(mock.injects.length, 0);
});
