'use strict';
/**
 * task-manager.js 持久化单元测试
 *
 * task-manager.js 依赖 electron 的 app.getPath('userData') 定位 tasks.json。
 * 参照 test/main/self-loop.test.js 的做法，用 Module._load 钩子 mock electron，
 * 把 userData 指向临时目录，隔离文件系统副作用。
 *
 * 模块加载时会自动 loadFromDisk()，因此每个测试需 fresh()（清 require 缓存后重新 require）。
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

function fresh() {
  delete require.cache[require.resolve('../../src/main/team/task-manager')];
  return require('../../src/main/team/task-manager');
}

function tasksFile() {
  return path.join(userDataDir, 'tasks.json');
}
function readRaw() {
  return JSON.parse(fs.readFileSync(tasksFile(), 'utf-8'));
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-tm-'));
  installMock();
});

afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/team/task-manager')];
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
});

test('createTask 后任务落盘到 tasks.json', () => {
  const tm = fresh();
  const t = tm.createTask('worker-1', 'hello', { module: 'm1', masterProfileId: 'master-1' });
  assert.ok(fs.existsSync(tasksFile()));
  const raw = readRaw();
  assert.strictEqual(raw.tasks.length, 1);
  assert.strictEqual(raw.tasks[0].id, t.id);
  assert.strictEqual(raw.tasks[0].prompt, 'hello');
  assert.strictEqual(raw.tasks[0].module, 'm1');
});

test('updateTaskStatus 后状态落盘', () => {
  const tm = fresh();
  const t = tm.createTask('w', 'p');
  tm.updateTaskStatus(t.id, 'RUNNING');
  const raw = readRaw();
  const persisted = raw.tasks.find((x) => x.id === t.id);
  assert.strictEqual(persisted.status, 'RUNNING');
});

test('重新加载模块时从盘恢复任务', () => {
  const tm1 = fresh();
  const t1 = tm1.createTask('worker-a', 'task one', { masterProfileId: 'm' });
  tm1.appendReport(t1.id, { level: 'SYNC', content: 'progress 50%' });

  // 模拟重启：清缓存后重新 require，应自动 loadFromDisk 恢复
  const tm2 = fresh();
  const restored = tm2.getTask(t1.id);
  assert.ok(restored, '任务应被恢复');
  assert.strictEqual(restored.prompt, 'task one');
  assert.strictEqual(restored.reports.length, 1);
  assert.strictEqual(restored.reports[0].content, 'progress 50%');
  assert.strictEqual(tm2.listTasks().length, 1);

  // loadFromDisk 应可显式调用且返回恢复条数
  const n = tm2.loadFromDisk();
  assert.strictEqual(n, 1);
});

test('容量上限：超过 200 条删除最旧的', () => {
  const tm = fresh();
  const first = tm.createTask('w', 'first');
  for (let i = 0; i < 205; i++) tm.createTask('w', 'task-' + i);
  assert.strictEqual(tm.tasks.size, 200);
  assert.strictEqual(tm.getTask(first.id), null, '最旧的任务应被删除');
  // 落盘内容也应 <= 200
  assert.ok(readRaw().tasks.length <= 200);
});

test('COMPLETED 终态自动收尾该 Worker 的 todo（全部标 completed）', () => {
  const tm = fresh();
  const todoStore = require('../../src/main/todo-store');
  todoStore.setTodos('worker-x', [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'pending' },
  ]);
  const t = tm.createTask('worker-x', 'p');
  tm.updateTaskStatus(t.id, 'COMPLETED', 'done');
  const after = todoStore.getTodos('worker-x');
  assert.strictEqual(after.list.length, 3);
  assert.ok(after.list.every((x) => x.status === 'completed'), '所有 todo 应收尾为 completed');
  // 内容保留
  assert.strictEqual(after.list[1].content, 'b');
});

test('FAILED 终态也收尾该 Worker 的 todo', () => {
  const tm = fresh();
  const todoStore = require('../../src/main/todo-store');
  todoStore.setTodos('worker-y', [{ content: 'a', status: 'in_progress' }]);
  const t = tm.createTask('worker-y', 'p');
  tm.updateTaskStatus(t.id, 'FAILED', 'boom');
  assert.strictEqual(todoStore.getTodos('worker-y').list[0].status, 'completed');
});

test('非终态（RUNNING）不触碰 todo', () => {
  const tm = fresh();
  const todoStore = require('../../src/main/todo-store');
  todoStore.setTodos('worker-z', [{ content: 'a', status: 'in_progress' }]);
  const t = tm.createTask('worker-z', 'p');
  tm.updateTaskStatus(t.id, 'RUNNING');
  assert.strictEqual(todoStore.getTodos('worker-z').list[0].status, 'in_progress');
});

test('落盘失败降级为仅内存且不抛错', () => {
  // 让 userData 指向一个"文件"而非目录，使 writeFileSync 失败（ENOTDIR）
  const fakeFile = path.join(userDataDir, 'not-a-dir');
  fs.writeFileSync(fakeFile, 'x');
  userDataDir = fakeFile;

  const tm = fresh();
  let t;
  assert.doesNotThrow(() => { t = tm.createTask('w', 'p'); });
  // 内存中仍存在
  assert.ok(tm.getTask(t.id));
  assert.strictEqual(tm.tasks.size, 1);
});

test('无 electron 环境（getPath 抛错）时降级为仅内存', () => {
  Module._load = function (request) {
    if (request === 'electron') {
      return { app: { getPath: () => { throw new Error('no userData'); } } };
    }
    return origLoad.apply(this, arguments);
  };
  const tm = fresh();
  let t;
  assert.doesNotThrow(() => { t = tm.createTask('w', 'p'); });
  assert.ok(tm.getTask(t.id));
});
