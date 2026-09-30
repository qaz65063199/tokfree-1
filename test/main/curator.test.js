'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const curator = require('../../src/main/team/curator');

// ===== shouldTrigger（触发判定，纯函数）=====

test('shouldTrigger 未启用返回 false', () => {
  const cfg = { enabled: false, idleMinutes: 30, minIntervalMinutes: 60 };
  const s = { idle: true, idleSince: 1000, lastReviewAt: 0, now: 1000 + 31 * 60000 };
  assert.strictEqual(curator.shouldTrigger(s, cfg), false);
});

test('shouldTrigger 系统不空闲返回 false', () => {
  const cfg = { enabled: true, idleMinutes: 30, minIntervalMinutes: 60 };
  const s = { idle: false, idleSince: 1000, lastReviewAt: 0, now: 1000 + 31 * 60000 };
  assert.strictEqual(curator.shouldTrigger(s, cfg), false);
});

test('shouldTrigger 空闲未满阈值返回 false', () => {
  const cfg = { enabled: true, idleMinutes: 30, minIntervalMinutes: 60 };
  const s = { idle: true, idleSince: 1000, lastReviewAt: 0, now: 1000 + 20 * 60000 };
  assert.strictEqual(curator.shouldTrigger(s, cfg), false);
});

test('shouldTrigger 空闲满阈值且无历史巡检返回 true', () => {
  const cfg = { enabled: true, idleMinutes: 30, minIntervalMinutes: 60 };
  const s = { idle: true, idleSince: 1000, lastReviewAt: 0, now: 1000 + 31 * 60000 };
  assert.strictEqual(curator.shouldTrigger(s, cfg), true);
});

test('shouldTrigger 距上次巡检不足最小间隔返回 false', () => {
  const cfg = { enabled: true, idleMinutes: 30, minIntervalMinutes: 60 };
  const now = 1000 + 31 * 60000;
  const s = { idle: true, idleSince: 1000, lastReviewAt: now - 10 * 60000, now: now };
  assert.strictEqual(curator.shouldTrigger(s, cfg), false);
});

test('shouldTrigger 距上次巡检超过最小间隔返回 true', () => {
  const cfg = { enabled: true, idleMinutes: 30, minIntervalMinutes: 60 };
  const now = 1000 + 31 * 60000;
  const s = { idle: true, idleSince: 1000, lastReviewAt: now - 61 * 60000, now: now };
  assert.strictEqual(curator.shouldTrigger(s, cfg), true);
});

// ===== buildBrief（简报拼装，纯函数；分步引导版）=====

test('buildBrief 含核心引导语（战略巡检）', () => {
  const brief = curator.buildBrief({}, {});
  assert.match(brief, /战略巡检/);
});

test('buildBrief 是分步引导：只执行第 1 步', () => {
  const brief = curator.buildBrief({}, {});
  assert.match(brief, /只执行第 1 步/);
  assert.match(brief, /不要一次做多步/);
});

test('buildBrief 强制引用 evolution-flywheel skill', () => {
  const brief = curator.buildBrief({}, {});
  assert.match(brief, /evolution-flywheel/);
  assert.match(brief, /skill_read/);
});

test('buildBrief 含项目目录', () => {
  const brief = curator.buildBrief({ projectDir: 'C:/proj' }, {});
  assert.match(brief, /C:\/proj/);
});

test('buildBrief 精简呈现 git（分支 + 未提交数，不给全文 log）', () => {
  const sig = { projectDir: 'C:/proj', git: { branch: 'main', status: 'M a.js' + String.fromCharCode(10) + 'M b.js', log: 'abc 修复' } };
  const brief = curator.buildBrief(sig, {});
  assert.match(brief, /git 分支：main/);
  assert.match(brief, /未提交改动：2 项/);
  assert.doesNotMatch(brief, /abc 修复/);
});

test('buildBrief 精简呈现 TODO（只给条数）', () => {
  const sig = { todos: ['a.js:1 TODO 修这个', 'b.js:2 FIXME 那个'] };
  const brief = curator.buildBrief(sig, {});
  assert.match(brief, /已知 TODO\/FIXME：约 2 条/);
});

test('buildBrief 单 Agent 模式分流文案', () => {
  const brief = curator.buildBrief({ profileId: 'winSolo' }, {});
  assert.match(brief, /单 Agent（single）/);
  assert.match(brief, /自己挑一条/);
});

test('buildBrief 多 Agent 模式分流文案（含 projectDir 提示）', () => {
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === './mode') return { getMode: () => 'multi' };
    return origLoad.apply(this, arguments);
  };
  try {
    const brief = curator.buildBrief({ profileId: 'winMulti', projectDir: 'C:/proj' }, {});
    assert.match(brief, /多 Agent（multi）/);
    assert.match(brief, /auto_goal_create/);
    assert.match(brief, /projectDir=C:\/proj/);
  } finally { Module._load = origLoad; }
});

test('buildBrief 追加自定义附加指令', () => {
  const brief = curator.buildBrief({}, { briefPrompt: '重点关注性能' });
  assert.match(brief, /附加指令/);
  assert.match(brief, /重点关注性能/);
});

test('buildBrief 空信号也能生成（不抛错）', () => {
  const brief = curator.buildBrief(null, null);
  assert.strictEqual(typeof brief, 'string');
  assert.ok(brief.length > 0);
});

test('buildBrief 含本项目硬约束文案', () => {
  const sig = { projectDir: 'C:/proj', profileId: 'winX' };
  const brief = curator.buildBrief(sig, {});
  assert.match(brief, /目标窗口：winX/);
  assert.match(brief, /只针对本项目/);
});


// ===== 默认配置 =====

test('DEFAULT_CONFIG 含关键可配置项且默认关闭', () => {
  const c = curator.DEFAULT_CONFIG;
  assert.strictEqual(c.enabled, false);
  assert.strictEqual(typeof c.idleMinutes, 'number');
  assert.strictEqual(typeof c.minIntervalMinutes, 'number');
  assert.strictEqual(typeof c.maxProposals, 'number');
  assert.ok(c.collect && typeof c.collect.git === 'boolean');
});

// ===== collectSignals：goals 按 profileId 过滤（禁止跨窗口污染）=====

function withSelfLoopMock(selfLoopMock, fn) {
  Module._load = function (request) {
    if (request === 'electron') return { app: { getPath: () => require('os').tmpdir() } };
    if (request === './self-loop') return selfLoopMock;
    return origLoad.apply(this, arguments);
  };
  try { return fn(); } finally { Module._load = origLoad; }
}

test('collectSignals 传 profileId 时 goals 只含本窗口 + 无归属目标', async () => {
  const goals = [
    { title: 'A已完成', status: 'achieved', profileId: 'winA' },
    { title: 'B已完成', status: 'achieved', profileId: 'winB' },
    { title: '全局已完成', status: 'achieved', profileId: '' },
  ];
  let receivedFilter = null;
  const selfLoopMock = {
    listGoals: (filter) => {
      receivedFilter = filter;
      let arr = goals.slice();
      if (filter && filter.profileId) arr = arr.filter((g) => !g.profileId || g.profileId === filter.profileId);
      return arr;
    },
  };
  const sig = await withSelfLoopMock(selfLoopMock, () =>
    curator.collectSignals('', { goals: true }, 'winA'));
  assert.deepStrictEqual(receivedFilter, { profileId: 'winA' });
  assert.strictEqual(sig.goals.length, 2);
  assert.ok(sig.goals.some((t) => t.indexOf('A已完成') !== -1));
  assert.ok(sig.goals.some((t) => t.indexOf('全局已完成') !== -1));
  assert.ok(!sig.goals.some((t) => t.indexOf('B已完成') !== -1), '不能含其他窗口目标');
});

test('collectSignals 不传 profileId 时不过滤 goals（向后兼容）', async () => {
  const goals = [
    { title: 'A', status: 'achieved', profileId: 'winA' },
    { title: 'B', status: 'achieved', profileId: 'winB' },
  ];
  let receivedFilter = 'unset';
  const selfLoopMock = { listGoals: (filter) => { receivedFilter = filter; return goals.slice(); } };
  const sig = await withSelfLoopMock(selfLoopMock, () =>
    curator.collectSignals('', { goals: true }));
  assert.strictEqual(receivedFilter, undefined);
  assert.strictEqual(sig.goals.length, 2);
});

// ===== 归属校验（禁止跨窗口错误 fallback）=====

const Module = require('module');
const origLoad = Module._load;

function withWindowMock(windowMock, fn) {
  Module._load = function (request) {
    if (request === 'electron') return { app: { getPath: () => require('os').tmpdir() } };
    if (request === '../window' || request === './window') return windowMock;
    if (request === './task-manager' || request === '../task-manager') return { isWorkerProfile: () => false };
    if (request === '../profile-manager') return { getProfileById: () => null };
    return origLoad.apply(this, arguments);
  };
  try { return fn(); } finally { Module._load = origLoad; }
}

test('resolveTargetContexts：指定 profileId 不存在 → 返回空（绝不 fallback）', () => {
  const windowState = {
    getWindowByProfileId: () => null,
    getMainContext: () => ({ profileId: 'main', win: { isDestroyed: () => false }, sessionStore: { state: { selectedProjectDir: 'C:/p' } } }),
    getAllContexts: () => [{ profileId: 'other', win: { isDestroyed: () => false } }],
  };
  withWindowMock(windowState, () => {
    curator.updateConfig({ targetProfileId: 'ghost', targetProfileIds: [] });
    const list = curator.resolveTargetContexts();
    assert.strictEqual(list.length, 0, '不能回退到主窗口或任意窗口');
  });
});

test('resolveTargetContexts：未指定 profileId → 遍历找到绑定项目的窗口', () => {
  const windowState = {
    getWindowByProfileId: () => null,
    getMainContext: () => null,
    getAllContexts: () => [{ profileId: 'main', win: { isDestroyed: () => false }, sessionStore: { state: { selectedProjectDir: 'C:/p' } } }],
  };
  withWindowMock(windowState, () => {
    curator.updateConfig({ targetProfileId: '', targetProfileIds: [] });
    const list = curator.resolveTargetContexts();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].profileId, 'main');
  });
});

test('resolveTargetContexts：指定 profileId 存在且已绑定项目 → 只返回该窗口', () => {
  const target = { profileId: 'p1', win: { isDestroyed: () => false }, sessionStore: { state: { selectedProjectDir: 'C:/p' } } };
  const windowState = {
    getWindowByProfileId: (id) => (id === 'p1' ? target : null),
    getMainContext: () => ({ profileId: 'main', win: { isDestroyed: () => false } }),
    getAllContexts: () => [target],
  };
  withWindowMock(windowState, () => {
    curator.updateConfig({ targetProfileId: 'p1', targetProfileIds: [] });
    const list = curator.resolveTargetContexts();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].profileId, 'p1');
  });
});

test('resolveTargetContexts：窗口未绑定项目（selectedProjectDir 空）→ 被跳过', () => {
  const target = { profileId: 'p1', win: { isDestroyed: () => false }, sessionStore: { state: { selectedProjectDir: '' } } };
  const windowState = {
    getWindowByProfileId: (id) => (id === 'p1' ? target : null),
    getMainContext: () => ({ profileId: 'main', win: { isDestroyed: () => false } }),
    getAllContexts: () => [target],
  };
  withWindowMock(windowState, () => {
    curator.updateConfig({ targetProfileId: 'p1', targetProfileIds: [] });
    const list = curator.resolveTargetContexts();
    assert.strictEqual(list.length, 0, '未绑定项目的窗口不应被选为巡检目标');
  });
});

test('resolveTargetContexts：未指定 → 遍历找到唯一绑定项目的 other 窗口', () => {
  const windowState = {
    getWindowByProfileId: () => null,
    getMainContext: () => null,
    getAllContexts: () => [{ profileId: 'other', win: { isDestroyed: () => false }, sessionStore: { state: { selectedProjectDir: 'C:/x' } } }],
  };
  withWindowMock(windowState, () => {
    curator.updateConfig({ targetProfileId: '', targetProfileIds: [] });
    const list = curator.resolveTargetContexts();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].profileId, 'other');
  });
});

test('runReviewForContext：项目目录一致 → 正常注入', async () => {
  const sent = [];
  const ctx = {
    profileId: 'p1',
    win: { isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } },
    sessionStore: { state: { selectedProjectDir: '' } },
  };
  const r = await curator.runReviewForContext(ctx);
  assert.strictEqual(r.success, true);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0][0], 'master-inject-message');
});

test('runReviewForContext：窗口不可用 → 返回失败', async () => {
  const r = await curator.runReviewForContext(null);
  assert.strictEqual(r.success, false);
});

test('getWindowProjectDir：正常读取/异常容错', () => {
  assert.strictEqual(curator.getWindowProjectDir({ sessionStore: { state: { selectedProjectDir: 'X' } } }), 'X');
  assert.strictEqual(curator.getWindowProjectDir(null), '');
  assert.strictEqual(curator.getWindowProjectDir({}), '');
});

// ===== 解死锁：本项目有 running goal → 跳过该项目窗口 =====

function withModulesMock(map, fn) {
  Module._load = function (request) {
    if (request === 'electron') return { app: { getPath: () => require('os').tmpdir() } };
    if (Object.prototype.hasOwnProperty.call(map, request)) return map[request];
    return origLoad.apply(this, arguments);
  };
  try { return fn(); } finally { Module._load = origLoad; }
}

test('runReviewForContext：本项目有 running goal → 跳过（不注入）', async () => {
  const sent = [];
  const ctx = {
    profileId: 'pRun',
    win: { isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } },
    sessionStore: { state: { selectedProjectDir: 'C:/proj' } },
  };
  const selfLoop = {
    listRunningGoals: (dir) => (dir === 'C:/proj' ? [{ id: 'g1', status: 'running', projectDir: 'C:/proj' }] : []),
    listGoals: () => [],
  };
  const r = await withModulesMock({ './self-loop': selfLoop }, () => curator.runReviewForContext(ctx));
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(sent.length, 0, '有 running goal 时不应注入');
});

test('runReviewForContext：本项目无 running goal → 巡检注入', async () => {
  const sent = [];
  const ctx = {
    profileId: 'pFree',
    win: { isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } },
    sessionStore: { state: { selectedProjectDir: 'C:/proj' } },
  };
  const selfLoop = { listRunningGoals: () => [], listGoals: () => [] };
  const ma = { isRecentlyInjected: () => false, noteInject: () => {} };
  const r = await withModulesMock({ './self-loop': selfLoop, './master-activity': ma }, () => curator.runReviewForContext(ctx));
  assert.strictEqual(r.success, true);
  assert.strictEqual(sent.length, 1);
});

test('runReviewForContext：近期已注入（互斥）→ 跳过', async () => {
  const sent = [];
  const ctx = {
    profileId: 'pMutex',
    win: { isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } },
    sessionStore: { state: { selectedProjectDir: 'C:/proj' } },
  };
  const selfLoop = { listRunningGoals: () => [], listGoals: () => [] };
  const ma = { isRecentlyInjected: (pid, ms) => pid === 'pMutex' && ms === 15000, noteInject: () => {} };
  const r = await withModulesMock({ './self-loop': selfLoop, './master-activity': ma }, () => curator.runReviewForContext(ctx));
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.skipped, true);
  assert.match(String(r.reason), /互斥/);
  assert.strictEqual(sent.length, 0, '互斥时不应注入');
});

test('hasRunningGoalForProject：有/无 running goal', async () => {
  const selfLoop = {
    listRunningGoals: (dir) => (dir === 'C:/x' ? [{}] : []),
    listGoals: () => [],
  };
  const has = await withModulesMock({ './self-loop': selfLoop }, async () =>
    curator.hasRunningGoalForProject('C:/x'));
  assert.strictEqual(has, true);
  const none = await withModulesMock({ './self-loop': selfLoop }, async () =>
    curator.hasRunningGoalForProject('C:/y'));
  assert.strictEqual(none, false);
});

// ===== collectSignals：goals 必须同时传 projectDir（严格项目过滤）=====

test('collectSignals 传 projectDir 时 listGoals 收到的 filter 含 projectDir', async () => {
  let receivedFilter = null;
  const selfLoopMock = { listGoals: (filter) => { receivedFilter = filter; return []; } };
  await withSelfLoopMock(selfLoopMock, () =>
    curator.collectSignals('C:/proj/one', { goals: true }, 'winA'));
  assert.deepStrictEqual(receivedFilter, { profileId: 'winA', projectDir: 'C:/proj/one' });
});

test('collectSignals 只传 projectDir（无 profileId）时 filter 仅含 projectDir', async () => {
  let receivedFilter = null;
  const selfLoopMock = { listGoals: (filter) => { receivedFilter = filter; return []; } };
  await withSelfLoopMock(selfLoopMock, () =>
    curator.collectSignals('C:/proj/one', { goals: true }));
  assert.deepStrictEqual(receivedFilter, { projectDir: 'C:/proj/one' });
});

test('collectSignals 简报 goals 排除 legacy 老数据 + 其他项目', async () => {
  // 模拟真实 self-loop：按 filter.projectDir 严格过滤（含 global:true 例外）
  const all = [
    { title: '本项目已完成', status: 'achieved', projectDir: 'C:/proj/one' },
    { title: '别的项目已完成', status: 'achieved', projectDir: 'C:/proj/two' },
    { title: '老跨项目目标', status: 'achieved', projectDir: '', legacy: true },
    { title: '本项目运行中', status: 'running', projectDir: 'C:/proj/one' },
  ];
  const selfLoopMock = {
    listGoals: (filter) => {
      let arr = all.slice();
      if (filter && filter.projectDir) {
        const dir = filter.projectDir;
        arr = arr.filter((g) => g.projectDir === dir || g.global === true);
      }
      return arr;
    },
  };
  const sig = await withSelfLoopMock(selfLoopMock, () =>
    curator.collectSignals('C:/proj/one', { goals: true }, 'winA'));
  assert.ok(sig.goals.some((t) => t.indexOf('本项目已完成') !== -1), '含本项目已完成目标');
  assert.ok(!sig.goals.some((t) => t.indexOf('别的项目') !== -1), '不含其他项目目标');
  assert.ok(!sig.goals.some((t) => t.indexOf('老跨项目目标') !== -1), '不含 legacy 老数据');
  assert.ok(!sig.goals.some((t) => t.indexOf('本项目运行中') !== -1), '不含 running 目标');
});
