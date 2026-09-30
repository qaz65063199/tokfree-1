'use strict';
/**
 * 主大脑硬约束测试（真实打到 JsRunner 内部）
 *
 * 目标：验证 tools/JsRunner.js 的 hostBridge 主大脑硬约束确实在物理层拦截写操作，
 * 而不只是 mock 层。做法：
 *   - 用 Module._load 钩子 mock role-manager / tool-policy / worker-activity / trace
 *   - 构造真实 JsRunner 实例（注入假 registry）
 *   - runner.run(code, dir, 'p1') 执行真实沙箱代码，断言返回结果
 *
 * 约束逻辑（JsRunner.js line 431-444）：
 *   role==='master' 且有 Worker 时，写操作(write/file_write/edit/file_edit/file_delete/delete/__bash/bash)被拒；
 *   只读/调度放行；非 master 或无 Worker 一律放行。
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const origLoad = Module._load;
let role = '';
let workers = [];

function installMock() {
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => require('os').tmpdir() } };
    }
    if (request === '../src/main/team/role-manager' || request.endsWith('/role-manager')) {
      return {
        getRole: () => ({ role: role, belongTo: '', dynamic: false }),
        getWorkersOf: () => workers,
      };
    }
    if (request === '../src/main/tool-policy' || request.endsWith('/tool-policy')) {
      return { checkPolicy: () => ({ action: 'allow' }) };
    }
    if (request === '../src/main/worker-activity' || request.endsWith('/worker-activity')) {
      return { touch: () => {} };
    }
    if (request === '../src/main/team/trace' || request.endsWith('/team/trace')) {
      return { recordStep: () => {} };
    }
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() { Module._load = origLoad; }

// 构造假 registry：所有 ops 都有对应工具，execute 返回 { success:true, data:'OK' }
function makeRegistry() {
  const tools = {};
  const ops = [
    'write', 'file_write', 'edit', 'file_edit', 'file_delete', 'delete',
    'read', 'read_lines', 'grep', 'glob', 'pwsh',
  ];
  for (const op of ops) {
    tools[op] = { execute: async () => ({ success: true, data: 'OK' }) };
  }
  return { get: (op) => tools[op] || null };
}

function freshRunner() {
  delete require.cache[require.resolve('../../tools/JsRunner')];
  const { JsRunner } = require('../../tools/JsRunner');
  return new JsRunner(makeRegistry());
}

beforeEach(() => { role = ''; workers = []; installMock(); });
afterEach(() => { uninstallMock(); });

// ---------- 拦截场景（master + 有 Worker + 写操作） ----------

test('master+有Worker+write → 被硬约束拦截', async () => {
  role = 'master'; workers = ['w1'];
  const r = await freshRunner().run('await write("a.js", "x");', process.cwd(), 'p1');
  assert.strictEqual(r.success, false, '应返回失败');
  assert.match(r.error, /主大脑约束/, '错误信息应含"主大脑约束"');
});

test('master+有Worker+edit → 被硬约束拦截', async () => {
  role = 'master'; workers = ['w1'];
  const r = await freshRunner().run('await edit("a.js", "x", "y");', process.cwd(), 'p1');
  assert.strictEqual(r.success, false);
  assert.match(r.error, /主大脑约束/);
});

test('master+有Worker+bash → 被硬约束拦截', async () => {
  role = 'master'; workers = ['w1'];
  const r = await freshRunner().run('await bash("echo hi");', process.cwd(), 'p1');
  assert.strictEqual(r.success, false);
  assert.match(r.error, /主大脑约束/);
});

test('master+有Worker+deleteFile → 被硬约束拦截', async () => {
  role = 'master'; workers = ['w1'];
  const r = await freshRunner().run('await deleteFile("a.js");', process.cwd(), 'p1');
  assert.strictEqual(r.success, false);
  assert.match(r.error, /主大脑约束/);
});

// ---------- 放行场景 ----------

test('master+有Worker+read → 放行（只读不拦）', async () => {
  role = 'master'; workers = ['w1'];
  const r = await freshRunner().run('await read("a.js");', process.cwd(), 'p1');
  assert.strictEqual(r.success, true, '只读操作应放行');
  assert.doesNotMatch(r.output || '', /主大脑约束/);
});

test('master+有Worker+grep → 放行（只读不拦）', async () => {
  role = 'master'; workers = ['w1'];
  const r = await freshRunner().run('await grep("foo", { path: "." });', process.cwd(), 'p1');
  assert.strictEqual(r.success, true);
});

test('master+无Worker+write → 放行（没 Worker 只能自己干）', async () => {
  role = 'master'; workers = [];
  const r = await freshRunner().run('await write("a.js", "x");', process.cwd(), 'p1');
  assert.strictEqual(r.success, true, '无 Worker 时写操作应放行');
});

test('单聊（role=""）+write → 放行', async () => {
  role = ''; workers = [];
  const r = await freshRunner().run('await write("a.js", "x");', process.cwd(), 'p1');
  assert.strictEqual(r.success, true, '单聊模式应放行');
});

test('worker+write → 放行（Worker 要干活）', async () => {
  role = 'worker'; workers = ['w1'];
  const r = await freshRunner().run('await write("a.js", "x");', process.cwd(), 'p1');
  assert.strictEqual(r.success, true, 'Worker 写操作应放行');
});
