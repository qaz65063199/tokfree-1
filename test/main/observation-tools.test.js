'use strict';
/**
 * ObservationTools 单元测试
 *
 * 覆盖 observation_add / observation_list / observation_merge 对 observations.js 的调用、
 * category 校验、limit 默认值、以及达到阈值时的 merge 提示。
 * 通过 Module._load 钩子 mock observations 模块，隔离文件系统。
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const origLoad = Module._load;

// 可编程的 mock observations 模块
let mockObs = null;
let addCalls = [];
let listCalls = [];
let reflectionCalls = [];

function installMock() {
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => '/tmp', setPath: () => {} } };
    }
    // 拦截 observations 模块（相对路径或绝对路径）
    if (/observations$/.test(request) || request === '../src/main/observations') {
      return mockObs;
    }
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() {
  Module._load = origLoad;
}

function freshTools() {
  delete require.cache[require.resolve('../../tools/ObservationTools')];
  return require('../../tools/ObservationTools');
}

beforeEach(() => {
  addCalls = [];
  listCalls = [];
  reflectionCalls = [];
  mockObs = {
    addObservation: (pid, obs) => {
      addCalls.push({ pid, obs });
      return { success: true, id: 'obs-1' };
    },
    listObservations: (pid, limit) => {
      listCalls.push({ pid, limit });
      return [{ id: 'obs-1', category: '决策', summary: 's', ts: 1 }];
    },
    addReflection: (pid, summary) => {
      reflectionCalls.push({ pid, summary });
      return { success: true, id: 'ref-1' };
    },
  };
  installMock();
});

afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../tools/ObservationTools')];
});

// ========== observation_add ==========
test('observation_add 调用 addObservation 并传 profileId', async () => {
  const T = freshTools();
  const tool = new T.ObservationAddTool();
  const res = await tool.execute({ category: '决策', summary: '选 X', __callerProfileId: 'p1' });
  assert.strictEqual(res.success, true);
  assert.strictEqual(addCalls.length, 1);
  assert.strictEqual(addCalls[0].pid, 'p1');
  assert.deepStrictEqual(addCalls[0].obs, { category: '决策', summary: '选 X' });
});

test('observation_add 缺 category/summary 报错', async () => {
  const T = freshTools();
  const tool = new T.ObservationAddTool();
  const res = await tool.execute({ category: '决策', __callerProfileId: 'p1' });
  assert.strictEqual(res.success, false);
  assert.strictEqual(addCalls.length, 0);
});

test('observation_add 传递 observations 层的错误', async () => {
  mockObs.addObservation = () => ({ success: false, error: '非法 category' });
  const T = freshTools();
  const tool = new T.ObservationAddTool();
  const res = await tool.execute({ category: 'bad', summary: 'x', __callerProfileId: 'p1' });
  assert.strictEqual(res.success, false);
  assert.match(res.error, /非法 category/);
});

test('observation_add 达阈值时提示 merge', async () => {
  mockObs.listObservations = () => new Array(15).fill({ id: 'o', category: '决策', summary: 's', ts: 1 });
  const T = freshTools();
  const tool = new T.ObservationAddTool();
  const res = await tool.execute({ category: '决策', summary: 'x', __callerProfileId: 'p1' });
  assert.strictEqual(res.success, true);
  assert.match(res.data.message, /observation_merge/);
});

// ========== observation_list ==========
test('observation_list 默认 limit=10', async () => {
  const T = freshTools();
  const tool = new T.ObservationListTool();
  const res = await tool.execute({ __callerProfileId: 'p1' });
  assert.strictEqual(res.success, true);
  assert.strictEqual(listCalls[0].limit, 10);
});

test('observation_list 传 limit 生效', async () => {
  const T = freshTools();
  const tool = new T.ObservationListTool();
  await tool.execute({ limit: 3, __callerProfileId: 'p1' });
  assert.strictEqual(listCalls[0].limit, 3);
});

test('observation_list 非法 limit 回退到 10', async () => {
  const T = freshTools();
  const tool = new T.ObservationListTool();
  await tool.execute({ limit: -5, __callerProfileId: 'p1' });
  assert.strictEqual(listCalls[0].limit, 10);
});

// ========== observation_merge ==========
test('observation_merge 调用 addReflection', async () => {
  const T = freshTools();
  const tool = new T.ObservationMergeTool();
  const res = await tool.execute({ summary: '高层结论', __callerProfileId: 'p1' });
  assert.strictEqual(res.success, true);
  assert.strictEqual(reflectionCalls.length, 1);
  assert.strictEqual(reflectionCalls[0].pid, 'p1');
  assert.strictEqual(reflectionCalls[0].summary, '高层结论');
});

test('observation_merge 缺 summary 报错', async () => {
  const T = freshTools();
  const tool = new T.ObservationMergeTool();
  const res = await tool.execute({ __callerProfileId: 'p1' });
  assert.strictEqual(res.success, false);
  assert.strictEqual(reflectionCalls.length, 0);
});
