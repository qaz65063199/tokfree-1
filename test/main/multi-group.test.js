'use strict';
/**
 * multi-group 测试：多组并行（两个 master，各自一组 worker，互不串组）
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const origLoad = Module._load;
let profiles = [];
let tasks = [];

function installMock() {
  Module._load = function (request) {
    if (request === '../profile-manager' || request === './profile-manager') {
      return {
        readProfiles: () => profiles,
        getProfileById: (id) => profiles.find(p => p.id === id) || null,
        updateProfile: (id, patch) => {
          const p = profiles.find(x => x.id === id);
          if (p) Object.assign(p, patch);
          return p;
        },
      };
    }
    if (request === './task-manager' || request === '../task-manager') {
      return { listTasks: () => tasks };
    }
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() { Module._load = origLoad; }
function fresh() {
  delete require.cache[require.resolve('../../src/main/team/role-manager')];
  return require('../../src/main/team/role-manager');
}

/** 构造两个 master 各自的 worker 组 */
function setupTwoGroups() {
  profiles = [
    { id: 'm1', role: 'master', belongTo: '' },
    { id: 'm2', role: 'master', belongTo: '' },
    { id: 'w1', role: 'worker', belongTo: 'm1' },
    { id: 'w2', role: 'worker', belongTo: 'm1' },
    { id: 'w3', role: 'worker', belongTo: 'm2' },
    { id: 'w4', role: 'worker', belongTo: 'm2' },
  ];
}

beforeEach(() => { profiles = []; tasks = []; installMock(); });
afterEach(() => { uninstallMock(); delete require.cache[require.resolve('../../src/main/team/role-manager')]; });

test('1. 两组并行：m1 与 m2 各带两个 worker，角色正确', () => {
  setupTwoGroups();
  const rm = fresh();
  assert.strictEqual(rm.getRole('m1').role, 'master');
  assert.strictEqual(rm.getRole('m2').role, 'master');
  assert.strictEqual(rm.getRole('w1').role, 'worker');
  assert.strictEqual(rm.getRole('w3').belongTo, 'm2');
});

test('2. getWorkersOf 不串组：m1→[w1,w2]，m2→[w3,w4]', () => {
  setupTwoGroups();
  const rm = fresh();
  const g1 = rm.getWorkersOf('m1').sort();
  const g2 = rm.getWorkersOf('m2').sort();
  assert.deepStrictEqual(g1, ['w1', 'w2']);
  assert.deepStrictEqual(g2, ['w3', 'w4']);
  // 不串组：m1 的组里不含 m2 的 worker
  assert.ok(!g1.includes('w3') && !g1.includes('w4'));
  assert.ok(!g2.includes('w1') && !g2.includes('w2'));
});

test('3. listMasters 返回 [m1,m2]', () => {
  setupTwoGroups();
  const rm = fresh();
  assert.deepStrictEqual(rm.listMasters().sort(), ['m1', 'm2']);
});

test('4. 动态场景：w1 有活跃任务归属 m1 → worker + belongTo=m1 + dynamic=true', () => {
  setupTwoGroups();
  tasks = [{ profileId: 'w1', status: 'RUNNING', masterProfileId: 'm1' }];
  const rm = fresh();
  const r = rm.getRole('w1');
  assert.strictEqual(r.role, 'worker');
  assert.strictEqual(r.belongTo, 'm1');
  assert.strictEqual(r.dynamic, true);
  // 动态归属生效后，getWorkersOf('m1') 仍包含 w1
  assert.ok(rm.getWorkersOf('m1').includes('w1'));
  // 未受影响的 w3 仍归 m2
  assert.ok(rm.getWorkersOf('m2').includes('w3'));
});

test('5. 改主：w1 从 m1 改绑到 m2 → 组归属正确转移', () => {
  setupTwoGroups();
  const rm = fresh();
  assert.ok(rm.getWorkersOf('m1').includes('w1'));
  // 改绑
  assert.strictEqual(rm.setWorker('w1', 'm2'), true);
  const g1 = rm.getWorkersOf('m1').sort();
  const g2 = rm.getWorkersOf('m2').sort();
  assert.deepStrictEqual(g1, ['w2'], 'm1 组不再含 w1');
  assert.deepStrictEqual(g2, ['w1', 'w3', 'w4'], 'm2 组新增 w1');
  assert.strictEqual(rm.getRole('w1').belongTo, 'm2');
});

test('6. 清除：clearRole(m1) → listMasters 不再含 m1', () => {
  setupTwoGroups();
  const rm = fresh();
  assert.ok(rm.listMasters().includes('m1'));
  assert.strictEqual(rm.clearRole('m1'), true);
  const ms = rm.listMasters();
  assert.ok(!ms.includes('m1'), 'm1 已从 master 列表移除');
  assert.ok(ms.includes('m2'), 'm2 不受影响');
  assert.strictEqual(rm.getRole('m1').role, '');
});

test('7. 多组隔离：一组的动态任务不影响另一组的静态归属', () => {
  setupTwoGroups();
  tasks = [{ profileId: 'w3', status: 'DISPATCHED', masterProfileId: 'm2' }];
  const rm = fresh();
  // w3 动态归 m2
  const r3 = rm.getRole('w3');
  assert.strictEqual(r3.dynamic, true);
  assert.strictEqual(r3.belongTo, 'm2');
  // w1/w2 仍静态归 m1，未受影响
  assert.deepStrictEqual(rm.getWorkersOf('m1').sort(), ['w1', 'w2']);
  // m2 组仍完整
  assert.deepStrictEqual(rm.getWorkersOf('m2').sort(), ['w3', 'w4']);
});
