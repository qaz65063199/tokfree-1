'use strict';
/**
 * metrics-feed.test.js —— 验证「数据上报链路」把 token / 任务指标写入 metrics-store
 *
 * 被测对象是两条链路的**调用侧**：
 *   1) token-tracker.setTokenCount → metricsStore.record(profileId, { tokensIn: 增量 })
 *   2) task-manager.updateTaskStatus(COMPLETED/FAILED) → metricsStore.record(profileId, { tasks, success/fail })
 *
 * 做法：用 Module._load 钩子 mock electron（userData→临时目录）；
 * token-tracker 依赖 ../core/agent-runtime/paths（非 electron），
 * task-manager 依赖 ../../core/agent-runtime/paths，二者最终都读 userData。
 * metrics-store 依赖 electron.app.getPath('userData')。
 * 每次用 fresh() 清 require 缓存，隔离模块内状态与文件。
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
  Module._load = function (request) {
    if (request === 'electron') {
      return { app: { getPath: () => userDataDir, setPath: () => {} } };
    }
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() { Module._load = origLoad; }

const RESOLVES = [
  '../../src/main/metrics-store',
  '../../src/main/token-tracker',
  '../../src/main/team/task-manager',
  '../../src/main/team/response-bus',
  '../../src/core/agent-runtime/paths',
];

function purge() {
  for (const r of RESOLVES) {
    try { delete require.cache[require.resolve(r)]; } catch (_) {}
  }
}

function freshTokenTracker() {
  purge();
  return require('../../src/main/token-tracker');
}
function freshTaskManager() {
  purge();
  return require('../../src/main/team/task-manager');
}

function metricsOf(profileId) {
  // 复用 token-tracker / task-manager 已 require 的同一 metrics-store 实例，
  // 否则重新 require 会从磁盘读取（数据还在内存 monthCache，未落盘）。
  const m = require('../../src/main/metrics-store');
  const d = m.getDaily(profileId);
  m.flush();
  return d;
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-mfeed-'));
  installMock();
});

afterEach(() => {
  uninstallMock();
  purge();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
});

// ========== 1. token 增量上报 ==========

test('token 累计增长时按增量累加到 metrics（不重复累加）', () => {
  const tt = freshTokenTracker();
  tt.setTokenCount('p1', 100);
  tt.setTokenCount('p1', 150);
  tt.setTokenCount('p1', 180);
  // 增量应为 100 + 50 + 30 = 180（累计值）
  const d = metricsOf('p1');
  assert.strictEqual(d.tokensIn, 180);
});

test('token 累计不变时不上报（增量为 0）', () => {
  const tt = freshTokenTracker();
  tt.setTokenCount('p1', 100);
  tt.setTokenCount('p1', 100); // 无变化
  tt.setTokenCount('p1', 100);
  const d = metricsOf('p1');
  assert.strictEqual(d.tokensIn, 100);
});

test('会话重置（累计变小）时按本次值计增量', () => {
  const tt = freshTokenTracker();
  tt.setTokenCount('p1', 500);
  // 会话重置：新会话累计从 20 开始
  tt.setTokenCount('p1', 20);
  const d = metricsOf('p1');
  // 500 + 20 = 520
  assert.strictEqual(d.tokensIn, 520);
});

test('非法 token 值不上报', () => {
  const tt = freshTokenTracker();
  tt.setTokenCount('p1', -5);   // 负数忽略
  tt.setTokenCount('p1', NaN);  // NaN 忽略
  tt.setTokenCount('', 100);    // 空 profileId 忽略
  const d = metricsOf('p1');
  assert.strictEqual(d.tokensIn, 0);
});

// ========== 2. 任务成功/失败上报 ==========

test('任务完成累加 tasks + success', () => {
  const tm = freshTaskManager();
  const t = tm.createTask('w1', 'do work');
  tm.updateTaskStatus(t.id, 'COMPLETED', 'done');
  const d = metricsOf('w1');
  assert.strictEqual(d.tasks, 1);
  assert.strictEqual(d.success, 1);
  assert.strictEqual(d.fail, 0);
});

test('任务失败累加 tasks + fail', () => {
  const tm = freshTaskManager();
  const t = tm.createTask('w2', 'do work');
  tm.updateTaskStatus(t.id, 'FAILED', 'boom');
  const d = metricsOf('w2');
  assert.strictEqual(d.tasks, 1);
  assert.strictEqual(d.success, 0);
  assert.strictEqual(d.fail, 1);
});

test('中间状态（DISPATCHED/RUNNING）不计任务指标', () => {
  const tm = freshTaskManager();
  const t = tm.createTask('w3', 'do work');
  tm.updateTaskStatus(t.id, 'DISPATCHED');
  tm.updateTaskStatus(t.id, 'RUNNING');
  const d = metricsOf('w3');
  assert.strictEqual(d.tasks, 0);
  assert.strictEqual(d.success, 0);
  assert.strictEqual(d.fail, 0);
});

test('状态未变化时不重复累加（幂等）', () => {
  const tm = freshTaskManager();
  const t = tm.createTask('w4', 'do work');
  tm.updateTaskStatus(t.id, 'COMPLETED', 'a');
  tm.updateTaskStatus(t.id, 'COMPLETED', 'a'); // 同状态重复调用
  const d = metricsOf('w4');
  assert.strictEqual(d.tasks, 1);
  assert.strictEqual(d.success, 1);
});
