'use strict';
/**
 * self-loop-driver 回合结束「防打断」单元测试
 *
 * 背景：AI 在工具循环中会多次「回复完成」，onTurnEnd 若同步注入会打断 AI。
 * 现已改为「延迟复查」：onTurnEnd 只记录回合结束时刻 + 设延迟定时器；
 * 定时器触发后 runTurnEndInject 复查（AI 空闲 + 期间无新回合 + 静默足够）才注入。
 *
 * 覆盖：
 *   1) onTurnEnd 同步返回后无注入（延迟生效）
 *   2) 延迟后满足条件才注入
 *   3) 延迟窗口内出现新回合 → 定时器重置，注入延后（只注入一次）
 *   4) AI 非空闲 → 不注入
 *   5) 静默时长不足 → 不注入
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
      return { inject: (profileId, message) => { mock.injects.push({ profileId, message, at: Date.now() }); return true; } };
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-turnguard-'));
  mock = {
    injects: [],
    selfLoop: {
      listGoals: () => [],
      listRunningGoals: () => [{ id: 'g1', profileId: 'p1', round: 0, status: 'running' }],
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

test('onTurnEnd：同步返回后不注入（延迟生效，防打断）', () => {
  drv = freshDriver();
  drv.CONFIG.turnEndDelayMs = 80;
  drv.CONFIG.quietSecs = 0;
  drv.onTurnEnd('p1');
  // 同步检查：此刻不应有任何注入（说明没有同步注入）
  assert.strictEqual(mock.injects.length, 0, 'onTurnEnd 返回时不应已注入');
});

test('onTurnEnd：延迟后满足条件才注入', async () => {
  drv = freshDriver();
  drv.CONFIG.turnEndDelayMs = 40;
  drv.CONFIG.quietSecs = 0;
  drv.onTurnEnd('p1');
  await sleep(130);
  assert.strictEqual(mock.injects.length, 1, '延迟到期后应注入一次');
  assert.strictEqual(mock.injects[0].profileId, 'p1');
});

test('onTurnEnd：延迟窗口内出现新回合 → 定时器重置，注入延后且只一次', async () => {
  drv = freshDriver();
  drv.CONFIG.turnEndDelayMs = 80;
  drv.CONFIG.quietSecs = 0;
  drv.onTurnEnd('p1');          // 第 1 次回合结束，计划 80ms 后注入
  await sleep(50);              // 还在窗口内
  drv.onTurnEnd('p1');          // 第 2 次回合结束 → 应清掉旧定时器、重设
  // 第 1 个定时器若未被清理，会在 ~80ms 注入；此处已到原时点附近，应仍为 0
  await sleep(40);
  assert.strictEqual(mock.injects.length, 0, '旧定时器应被新回合清掉，尚未注入');
  // 再等过第 2 个定时器的完整时长 → 注入一次
  await sleep(80);
  assert.strictEqual(mock.injects.length, 1, '最终只注入一次');
});

test('onTurnEnd：AI 非空闲 → 延迟到期也不注入', async () => {
  mock.watchdog.getStatus = () => ({ profile: { busy: true } });
  drv = freshDriver();
  drv.CONFIG.turnEndDelayMs = 40;
  drv.CONFIG.quietSecs = 0;
  drv.onTurnEnd('p1');
  await sleep(130);
  assert.strictEqual(mock.injects.length, 0, 'AI 忙时不应注入');
});

test('onTurnEnd：静默时长不足 → 不注入', async () => {
  drv = freshDriver();
  drv.CONFIG.turnEndDelayMs = 20; // 定时器很快触发
  drv.CONFIG.quietSecs = 10;      // 但要求静默 10s，远未达到
  drv.onTurnEnd('p1');
  await sleep(80);
  assert.strictEqual(mock.injects.length, 0, '静默不足应取消注入');
});

test('onTurnEnd：无 running goal → 延迟后也不注入', async () => {
  mock.selfLoop.listRunningGoals = () => [];
  drv = freshDriver();
  drv.CONFIG.turnEndDelayMs = 40;
  drv.CONFIG.quietSecs = 0;
  drv.onTurnEnd('p1');
  await sleep(120);
  assert.strictEqual(mock.injects.length, 0);
});
