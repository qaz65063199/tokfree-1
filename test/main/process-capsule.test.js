'use strict';
/**
 * 进程胶囊（process-capsule.js）纯函数测试。
 * 该模块是浏览器 IIFE（挂 window.ProcessCapsule），这里只测不依赖 DOM 的
 * fmtDur（时长格式化）与 classify（状态分类 + 「工作中」判定）。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

// 在隔离沙箱中加载模块：提供最小 window/globalThis，不触发 DOM 访问。
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ui', 'process-capsule.js'), 'utf8');
const sandbox = { window: {}, console, setInterval: () => 0, clearInterval: () => {}, localStorage: { getItem: () => null, setItem: () => {} } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const capsule = sandbox.window.ProcessCapsule;
const { fmtDur, classify, pillState, todoStale, planModulesToSteps, planAllDone } = capsule._test;

test('fmtDur 格式化时长（分/时）', () => {
  assert.strictEqual(fmtDur(0), '0分0秒');
  assert.strictEqual(fmtDur(5000), '0分5秒');
  assert.strictEqual(fmtDur(65 * 1000), '1分5秒');
  assert.strictEqual(fmtDur((3600 + 120 + 3) * 1000), '1时2分3秒');
  assert.strictEqual(fmtDur(-100), '0分0秒');
});

test('classify 统计各状态数量', () => {
  const todos = [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'completed' },
    { content: 'c', status: 'in_progress' },
    { content: 'd', status: 'pending' },
  ];
  const c = classify(todos, false);
  assert.strictEqual(c.done, 2);
  assert.strictEqual(c.active, 1);
  assert.strictEqual(c.pending, 1);
  assert.strictEqual(c.allDone, false);
  assert.strictEqual(c.hasActive, true); // 有 in_progress
});

test('classify 全部完成 → allDone 且非工作中', () => {
  const todos = [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'completed' },
  ];
  const c = classify(todos, false);
  assert.strictEqual(c.allDone, true);
  assert.strictEqual(c.hasActive, false);
});

test('classify：running 但无 in_progress 且未全完成 → 视为工作中', () => {
  const todos = [{ content: 'a', status: 'pending' }];
  const c = classify(todos, true);
  assert.strictEqual(c.hasActive, true);
});

test('classify：空列表不算 allDone；running 时算工作中（无 todo 也显示工作中）', () => {
  const idle = classify([], false);
  assert.strictEqual(idle.allDone, false);
  assert.strictEqual(idle.hasActive, false);
  const running = classify([], true);
  assert.strictEqual(running.allDone, false);
  assert.strictEqual(running.hasActive, true);
});

test('pillState：空 todos 仍可见（idle 空闲态，不再隐藏）', () => {
  const ps = pillState([], false, 0, null);
  assert.strictEqual(ps.kind, 'idle');
  assert.strictEqual(ps.label, '空闲');
  assert.strictEqual(ps.timer, '');
});

test('pillState：空 todos 但 running → working 带计时（AI 运行中即使无 todo 也显示工作中）', () => {
  const ps = pillState([], true, 65 * 1000, null);
  assert.strictEqual(ps.kind, 'working');
  assert.strictEqual(ps.label, '工作中');
  assert.strictEqual(ps.timer, '1分5秒');
});

test('pillState：有 in_progress → working 带计时', () => {
  const ps = pillState([{ content: 'a', status: 'in_progress' }], false, 65 * 1000, null);
  assert.strictEqual(ps.kind, 'working');
  assert.strictEqual(ps.label, '工作中');
  assert.strictEqual(ps.timer, '1分5秒');
});

test('pillState：全部完成 → done 显示项数与用时', () => {
  const ps = pillState([{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }], false, 0, 90 * 1000);
  assert.strictEqual(ps.kind, 'done');
  assert.strictEqual(ps.label, '已完成 2 项');
  assert.strictEqual(ps.timer, '用时 1分30秒');
});

test('pillState：有 pending 未完成 → pending 待办 N 项', () => {
  const ps = pillState([{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }], false, 0, null);
  assert.strictEqual(ps.kind, 'pending');
  assert.strictEqual(ps.label, '待办 2 项');
});

// ===== plan（多 Agent 模式）数据源 =====

test('planModulesToSteps：状态映射 + 模块名 + @分工', () => {
  const plan = {
    modules: [
      { id: 'm1', name: '后端接口', status: 'done', assignee: 'w1' },
      { id: 'm2', name: '前端页面', status: 'assigned', assignee: 'w2' },
      { id: 'm3', name: '联调', status: 'ready', assignee: '' },
      { id: 'm4', name: '文档', status: 'pending' },
      { id: 'm5', name: '旧方案', status: 'skipped' },
      { id: 'm6', name: '坏模块', status: 'failed' },
    ],
  };
  const steps = planModulesToSteps(plan);
  assert.strictEqual(steps.length, 6);
  // done → completed
  assert.strictEqual(steps[0].status, 'completed');
  assert.ok(steps[0].content.indexOf('后端接口') === 0);
  assert.ok(steps[0].content.indexOf('@w1') > 0);
  // assigned → in_progress
  assert.strictEqual(steps[1].status, 'in_progress');
  assert.ok(steps[1].content.indexOf('@w2') > 0);
  // ready → in_progress
  assert.strictEqual(steps[2].status, 'in_progress');
  // pending → pending
  assert.strictEqual(steps[3].status, 'pending');
  // skipped → completed
  assert.strictEqual(steps[4].status, 'completed');
  // failed → completed + ✗ 标记
  assert.strictEqual(steps[5].status, 'completed');
  assert.ok(steps[5].content.indexOf('✗') === 0);
  assert.strictEqual(steps[5].failed, true);
});

test('planModulesToSteps：无 assignee 不加 @', () => {
  const steps = planModulesToSteps({ modules: [{ id: 'm1', name: '任务A', status: 'ready' }] });
  assert.strictEqual(steps[0].content, '任务A');
});

test('planModulesToSteps：空/非法 plan → 空数组', () => {
  // 注意：模块运行在 vm 沙箱（独立 realm），其 Array 原型与本文件不同，
  // 跨 realm 用 deepStrictEqual 会误报；改用 length 断言。
  assert.strictEqual(planModulesToSteps(null).length, 0);
  assert.strictEqual(planModulesToSteps({}).length, 0);
  assert.strictEqual(planModulesToSteps({ modules: [] }).length, 0);
});

test('planAllDone：全部 done/skipped/failed → true；有未完成 → false', () => {
  assert.strictEqual(planAllDone({ modules: [{ status: 'done' }, { status: 'skipped' }, { status: 'failed' }] }), true);
  assert.strictEqual(planAllDone({ modules: [{ status: 'done' }, { status: 'assigned' }] }), false);
  assert.strictEqual(planAllDone({ modules: [{ status: 'pending' }] }), false);
  assert.strictEqual(planAllDone({ modules: [] }), false);
  assert.strictEqual(planAllDone(null), false);
});

test('pillState：plan 模式 forceActive=true 未全完成 → working 带计时（不依赖 running）', () => {
  const todos = [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'pending' },
  ];
  // running=false，但 forceActive=true → 仍 working
  const ps = pillState(todos, false, 125 * 1000, null, true);
  assert.strictEqual(ps.kind, 'working');
  assert.strictEqual(ps.label, '工作中');
  assert.strictEqual(ps.timer, '2分5秒');
});

test('pillState：plan 模式全完成 forceActive=true → done（冻结）', () => {
  const todos = [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'completed' },
  ];
  const ps = pillState(todos, false, 0, 300 * 1000, true);
  assert.strictEqual(ps.kind, 'done');
  assert.strictEqual(ps.label, '已完成 2 项');
  assert.strictEqual(ps.timer, '用时 5分0秒');
});

test('pillState：forceActive=true 但全完成 → 不强制 working', () => {
  const todos = [{ content: 'a', status: 'completed' }];
  const ps = pillState(todos, false, 0, 10 * 1000, true);
  assert.strictEqual(ps.kind, 'done');
});

// ===== todo 超时兜底 =====

test('todoStale：有 in_progress + 未运行 + 超过阈值 → true', () => {
  const now = 1000000;
  assert.strictEqual(todoStale(1, false, now - 6 * 60 * 1000, now), true);
});

test('todoStale：运行中 / 无 in_progress / 未超时 → false', () => {
  const now = 1000000;
  assert.strictEqual(todoStale(1, true, now - 10 * 60 * 1000, now), false, '运行中不算 stale');
  assert.strictEqual(todoStale(0, false, now - 10 * 60 * 1000, now), false, '无 in_progress 不算 stale');
  assert.strictEqual(todoStale(1, false, now - 1 * 60 * 1000, now), false, '未超时不算 stale');
  assert.strictEqual(todoStale(1, false, 0, now), false, '无活跃时间戳不算 stale');
});

test('todoStale：自定义阈值生效', () => {
  const now = 1000000;
  assert.strictEqual(todoStale(1, false, now - 100, now, 50), true);
});

test('pillState：stale=true → 按已完成呈现（冻结计时，不再工作中）', () => {
  const todos = [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }];
  const ps = pillState(todos, false, 0, 90 * 1000, false, true);
  assert.strictEqual(ps.kind, 'done');
  assert.strictEqual(ps.label, '已完成 2 项');
  assert.strictEqual(ps.timer, '用时 1分30秒');
});

test('pillState：无 stale 时有 in_progress 仍为 working（回归保护）', () => {
  const ps = pillState([{ content: 'a', status: 'in_progress' }], false, 65 * 1000, null);
  assert.strictEqual(ps.kind, 'working');
});

test('init 接受 onActiveChange 选项（无 DOM 时不抛错）', () => {
  assert.doesNotThrow(() => capsule.init({ onActiveChange: function () {} }));
});
