'use strict';
/**
 * role-manager 测试：角色 + 归属（belongTo）
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

beforeEach(() => { profiles = []; tasks = []; installMock(); });
afterEach(() => { uninstallMock(); delete require.cache[require.resolve('../../src/main/team/role-manager')]; });

test('setMaster 设置 master 并清空 belongTo', () => {
  profiles = [{ id: 'm1' }];
  const rm = fresh();
  rm.setMaster('m1');
  const r = rm.getRole('m1');
  assert.strictEqual(r.role, 'master');
  assert.strictEqual(r.belongTo, '');
});

test('setWorker 记录归属', () => {
  profiles = [{ id: 'w1' }];
  const rm = fresh();
  rm.setWorker('w1', 'm1');
  const r = rm.getRole('w1');
  assert.strictEqual(r.role, 'worker');
  assert.strictEqual(r.belongTo, 'm1');
});

test('★动态优先：有活跃任务 → worker，belongTo 来自 task', () => {
  profiles = [{ id: 'w1' }];
  tasks = [{ profileId: 'w1', status: 'RUNNING', masterProfileId: 'm1' }];
  const rm = fresh();
  const r = rm.getRole('w1');
  assert.strictEqual(r.role, 'worker');
  assert.strictEqual(r.belongTo, 'm1');
  assert.strictEqual(r.dynamic, true);
});

test('★任务完成 → 回退到持久化角色', () => {
  profiles = [{ id: 'w1', role: 'worker', belongTo: 'm1' }];
  tasks = [{ profileId: 'w1', status: 'COMPLETED', masterProfileId: 'm1' }];
  const rm = fresh();
  const r = rm.getRole('w1');
  assert.strictEqual(r.role, 'worker', '任务完成后仍保持 worker（共享资源池）');
  assert.strictEqual(r.dynamic, false);
});

test('getWorkersOf 返回某 master 的所有 worker', () => {
  profiles = [
    { id: 'm1', role: 'master' },
    { id: 'w1', role: 'worker', belongTo: 'm1' },
    { id: 'w2', role: 'worker', belongTo: 'm1' },
    { id: 'w3', role: 'worker', belongTo: 'm2' },
  ];
  const rm = fresh();
  const ws = rm.getWorkersOf('m1');
  assert.strictEqual(ws.length, 2);
  assert.ok(ws.includes('w1') && ws.includes('w2'));
});

test('clearRole 清空角色', () => {
  profiles = [{ id: 'w1', role: 'worker', belongTo: 'm1' }];
  const rm = fresh();
  rm.clearRole('w1');
  const r = rm.getRole('w1');
  assert.strictEqual(r.role, '');
  assert.strictEqual(r.belongTo, '');
});

test('listMasters 返回所有 master', () => {
  profiles = [{ id: 'm1', role: 'master' }, { id: 'm2', role: 'master' }, { id: 'w1', role: 'worker' }];
  const rm = fresh();
  const ms = rm.listMasters();
  assert.strictEqual(ms.length, 2);
});
