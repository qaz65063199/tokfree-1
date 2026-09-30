'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const origLoad = Module._load;

// 每个测试用独立的临时 userData 目录，隔离 watchdog-config.json
let tmpDir;
let powerStarts;
let powerStops;

function installMock() {
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: { getPath: () => tmpDir },
        powerSaveBlocker: {
          start: (type) => { powerStarts.push(type); return powerStarts.length; },
          stop: (id) => { powerStops.push(id); },
        },
        powerMonitor: { on: () => {} },
      };
    }
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() {
  Module._load = origLoad;
}

function freshWatchdog() {
  delete require.cache[require.resolve('../../src/main/watchdog')];
  return require('../../src/main/watchdog');
}

// 清掉看门狗定时器（若启动过）
let currentWd = null;
function stopWd() {
  if (currentWd && typeof currentWd.stop === 'function') {
    try { currentWd.stop(); } catch (_) {}
  }
  currentWd = null;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-wd-'));
  powerStarts = [];
  powerStops = [];
  installMock();
});

afterEach(() => {
  stopWd();
  uninstallMock();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  delete require.cache[require.resolve('../../src/main/watchdog')];
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 轮询等待条件成立，避免固定 sleep 在负载高时 tick 次数不足导致 flaky
async function waitFor(cond, timeoutMs = 3000, stepMs = 15) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await sleep(stepMs);
  }
  return cond();
}

// ========== 暗号检测 ==========

test('containsDoneKeyword 检测暗号', () => {
  const wd = freshWatchdog();
  wd.updateConfig({ doneKeyword: '紫电青霜-7391' });
  assert.strictEqual(wd.containsDoneKeyword('全部完成 紫电青霜-7391'), true);
  assert.strictEqual(wd.containsDoneKeyword('还没做完'), false);
  assert.strictEqual(wd.containsDoneKeyword(''), false);
  assert.strictEqual(wd.containsDoneKeyword(null), false);
});

test('doneKeyword 为空时不误判', () => {
  const wd = freshWatchdog();
  wd.updateConfig({ doneKeyword: '' });
  assert.strictEqual(wd.containsDoneKeyword('任意文本'), false);
});

// ========== scheduleConfirm ==========

test('scheduleConfirm：未在监护中返回 false', () => {
  const wd = freshWatchdog();
  const r = wd.scheduleConfirm('p1', '任意');
  assert.strictEqual(r, false);
});

test('scheduleConfirm：含暗号 → 解除监护、返回 false', () => {
  const wd = freshWatchdog();
  wd.updateConfig({ doneKeyword: 'DONE-KW' });
  wd.register('p1');
  wd.arm('p1');
  const kw = wd.getDoneKeyword('p1');
  const r = wd.scheduleConfirm('p1', '任务已全部完成 ' + kw);
  assert.strictEqual(r, false);
  assert.strictEqual(wd.getStatus('p1').profile.expectingReply, false);
});

test('scheduleConfirm：无暗号 → 进入 confirm 模式、返回 true', () => {
  const wd = freshWatchdog();
  wd.updateConfig({ doneKeyword: 'DONE-KW' });
  wd.register('p1');
  wd.arm('p1');
  const r = wd.scheduleConfirm('p1', '我完成了第一步。');
  assert.strictEqual(r, true);
  const st = wd.getStatus('p1').profile;
  assert.strictEqual(st.mode, 'confirm');
  assert.strictEqual(st.expectingReply, true);
  assert.strictEqual(st.nagCount, 0);
});

// ========== 连续催促上限 ==========

test('confirm 模式：按 confirmDelay 催促，达 maxNags 后停止', async () => {
  const wd = freshWatchdog();
  currentWd = wd;
  wd.updateConfig({ confirmDelay: 0, maxNags: 3, minGap: 0, interval: 9999, interruptInterval: 9999, doneKeyword: 'DONE-KW' });
  const wakes = [];
  wd.start({ onWake: (pid) => wakes.push(pid), tickMs: 15 });
  wd.register('p1');
  wd.arm('p1');
  wd.scheduleConfirm('p1', '第一步完成');

  await waitFor(() => wakes.filter((p) => p === 'p1').length >= 3);
  const count = wakes.filter((p) => p === 'p1').length;
  assert.strictEqual(count, 3, '应恰好催促 maxNags=3 次');
  const st = wd.getStatus('p1').profile;
  assert.strictEqual(st.nagCount, 3);
  assert.strictEqual(st.expectingReply, false, '达上限后应解除监护');

  // 再等一段时间不应有新催促（验证"不再发生"必须固定等待一段时间）
  await sleep(200);
  assert.strictEqual(wakes.filter((p) => p === 'p1').length, 3, '达上限后不再催促');
});

test('confirm 催促语包含暗号', async () => {
  const wd = freshWatchdog();
  currentWd = wd;
  wd.updateConfig({ confirmDelay: 0, maxNags: 1, minGap: 0, interval: 9999, interruptInterval: 9999 });
  const msgs = [];
  wd.start({ onWake: (pid, msg) => msgs.push(msg), tickMs: 15 });
  wd.register('p1');
  wd.arm('p1');
  const kw = wd.getDoneKeyword('p1'); // 实际随机暗号
  wd.scheduleConfirm('p1', '完成了一步');
  await sleep(150);
  assert.ok(msgs.length >= 1);
  assert.ok(msgs[0].includes(kw), '催促语应包含当前随机暗号');
});

// ========== arm reset 语义 ==========

test('arm(reset=false) 保留 confirm 计数；arm(reset=true) 重置', () => {
  const wd = freshWatchdog();
  wd.updateConfig({ doneKeyword: 'DONE-KW' });
  wd.register('p1');
  wd.arm('p1');
  wd.scheduleConfirm('p1', '未完成');

  // 模拟看门狗自身催促消息回传：arm(false) 不应重置
  wd.arm('p1', false);
  assert.strictEqual(wd.getStatus('p1').profile.mode, 'confirm');
  assert.strictEqual(wd.getStatus('p1').profile.nagCount, 0);

  // 用户主动发送：arm(true) 重置
  wd.arm('p1', true);
  assert.strictEqual(wd.getStatus('p1').profile.mode, 'interrupt');
  assert.strictEqual(wd.getStatus('p1').profile.nagCount, 0);
});

test('arm 默认重置（不带第二参）', () => {
  const wd = freshWatchdog();
  wd.updateConfig({ doneKeyword: 'DONE-KW' });
  wd.register('p1');
  wd.arm('p1');
  wd.scheduleConfirm('p1', '未完成');
  wd.arm('p1');
  assert.strictEqual(wd.getStatus('p1').profile.mode, 'interrupt');
});

// ========== 中断标记 ==========

test('markInterrupted 设置中断模式并刷新心跳', () => {
  const wd = freshWatchdog();
  wd.register('p1');
  wd.arm('p1');
  wd.scheduleConfirm('p1', '未完成');
  wd.markInterrupted('p1');
  const st = wd.getStatus('p1').profile;
  assert.strictEqual(st.interrupted, true);
  assert.strictEqual(st.mode, 'interrupt');
});

test('markInterrupted 对未监护的 profile 无副作用', () => {
  const wd = freshWatchdog();
  wd.register('p1');
  wd.markInterrupted('p1'); // 未 arm
  const st = wd.getStatus('p1').profile;
  assert.strictEqual(st.interrupted, false);
});

// ========== disarm ==========

test('disarm 解除监护并重置模式', () => {
  const wd = freshWatchdog();
  wd.register('p1');
  wd.arm('p1');
  wd.scheduleConfirm('p1', '未完成');
  wd.disarm('p1');
  const st = wd.getStatus('p1').profile;
  assert.strictEqual(st.expectingReply, false);
  assert.strictEqual(st.mode, 'interrupt');
});

// ========== 电源保持 ==========

test('有活跃监护时开启电源保持，空闲释放', () => {
  const wd = freshWatchdog();
  wd.updateConfig({ doneKeyword: 'DONE-KW' });
  wd.register('p1');
  wd.arm('p1');
  assert.deepStrictEqual(powerStarts, ['prevent-app-suspension']);
  wd.disarm('p1');
  assert.strictEqual(powerStops.length, 1);
});

// ========== getStatus ==========

test('getStatus 暴露 config 与 profile 关键字段', () => {
  const wd = freshWatchdog();
  wd.updateConfig({ doneKeyword: 'DONE-KW', maxNags: 7 });
  wd.register('p1');
  const s = wd.getStatus('p1');
  assert.strictEqual(typeof s.config.interval, 'number');
  assert.strictEqual(s.config.msg !== undefined, true);
  assert.strictEqual(s.profile.mode, 'interrupt');
  assert.strictEqual(s.profile.nagCount, 0);
});
