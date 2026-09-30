/**
 * 角色管理器（Role Manager）—— 统一管理"主大脑/子Agent"角色与归属
 *
 * 背景：之前 role 散落在 ipc.js（set-team-mode 标 master）、dispatch.js（标 worker），
 * 且只有扁平标签，**无法表达"哪个 worker 属于哪个 master"**（多组场景需要）。
 *
 * 本模块统一入口 + 归属关系（belongTo）：
 *   - role: 'master' | 'worker' | ''（空=单聊/未分配）
 *   - belongTo: 仅 worker 有，记录所属 master 的 profileId
 *
 * 真相来源（Source of Truth）优先级：
 *   1. 有活跃子任务 → worker，belongTo=task.masterProfileId（最准，动态）
 *   2. profile.role / profile.belongTo（持久化，跨重启）
 *   3. 空
 */
const NL = String.fromCharCode(10);

function pm() {
  try { return require('../profile-manager'); } catch (_) { return null; }
}

/** 设为 master（清除自己的 belongTo） */
function setMaster(profileId) {
  if (!profileId) return false;
  const p = pm();
  if (!p || !p.updateProfile) return false;
  try { p.updateProfile(profileId, { role: 'master', belongTo: '' }); return true; } catch (_) { return false; }
}

/** 设为 worker，并记录所属 master */
function setWorker(profileId, masterProfileId) {
  if (!profileId) return false;
  const p = pm();
  if (!p || !p.updateProfile) return false;
  try { p.updateProfile(profileId, { role: 'worker', belongTo: masterProfileId || '' }); return true; } catch (_) { return false; }
}

/** 清除角色 */
function clearRole(profileId) {
  if (!profileId) return false;
  const p = pm();
  if (!p || !p.updateProfile) return false;
  try { p.updateProfile(profileId, { role: '', belongTo: '' }); return true; } catch (_) { return false; }
}

/**
 * 读取角色（动态判定优先）。
 * @returns {{role:string, belongTo:string, dynamic:boolean}}
 */
function getRole(profileId) {
  if (!profileId) return { role: '', belongTo: '', dynamic: false };
  // 1. 动态：有活跃子任务 → worker + 归属
  try {
    const tm = require('./task-manager');
    const tasks = tm.listTasks ? tm.listTasks() : [];
    const active = ['PENDING', 'DISPATCHED', 'RUNNING', 'WAITING_MASTER'];
    const t = tasks.find(function (x) { return x.profileId === profileId && active.indexOf(x.status) !== -1; });
    if (t) return { role: 'worker', belongTo: t.masterProfileId || '', dynamic: true };
  } catch (_) {}
  // 2. 持久化
  try {
    const p = pm();
    const pr = p && p.getProfileById ? p.getProfileById(profileId) : null;
    if (pr && pr.role) return { role: pr.role, belongTo: pr.belongTo || '', dynamic: false };
  } catch (_) {}
  return { role: '', belongTo: '', dynamic: false };
}

/** 某 master 的所有 worker */
function getWorkersOf(masterProfileId) {
  if (!masterProfileId) return [];
  const out = [];
  try {
    const p = pm();
    const all = p && p.readProfiles ? p.readProfiles() : [];
    for (const pr of all) {
      const r = getRole(pr.id);
      if (r.role === 'worker' && r.belongTo === masterProfileId) out.push(pr.id);
    }
  } catch (_) {}
  return out;
}

/** 全部 master */
function listMasters() {
  const out = [];
  try {
    const p = pm();
    const all = p && p.readProfiles ? p.readProfiles() : [];
    for (const pr of all) {
      if (getRole(pr.id).role === 'master') out.push(pr.id);
    }
  } catch (_) {}
  return out;
}

module.exports = { setMaster, setWorker, clearRole, getRole, getWorkersOf, listMasters };
