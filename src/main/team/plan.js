/**
 * 任务计划（Plan）—— 多 Agent 编排的「规划层」状态
 *
 * 一个 plan 对应主大脑（Manager）的一次编排：目标 + 模块列表（含依赖、验收标准、状态）。
 * Manager 只负责「规划 + 验收 + 指导」；具体执行由 Worker 完成。
 *
 * 状态流转：
 *   pending（依赖未满足）→ ready（可派发）→ assigned（已派给 Worker）→ done / failed
 *
 * 纯状态模块：不做网络/窗口操作；由 scheduler 驱动、由 dispatch/ipc 联动更新。
 */

const NL = String.fromCharCode(10);
const fs = require('fs');
// assigned 模块超时兜底：模块被派发后超过此时长且对应 task 无活动 → 自动标记 failed，
// 避免 task 卡死/失败/取消后模块永远停在 assigned 导致 plan 永不完成。
let assignTimeoutMs = 30 * 60 * 1000;
function _setAssignTimeoutMs(ms) { assignTimeoutMs = Number(ms) > 0 ? Number(ms) : 0; }
function _getAssignTimeoutMs() { return assignTimeoutMs; }
const path = require('path');
const { getBaseDir } = require('../../core/agent-runtime/paths');

// masterProfileId -> plan
const plans = new Map();

// ===== 持久化：计划重启不丢 =====
let PLAN_FILE = null;
function getPlanFile() {
  if (PLAN_FILE) return PLAN_FILE;
  try {
    PLAN_FILE = path.join(getBaseDir(), 'plans.json');
  } catch (_) { PLAN_FILE = ''; }
  return PLAN_FILE;
}
function persist() {
  const file = getPlanFile();
  if (!file) return;
  try {
    const arr = [];
    plans.forEach(function (p) { arr.push(p); });
    fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8');
  } catch (_) { /* 降级：仅内存 */ }
}
function loadFromDisk() {
  const file = getPlanFile();
  if (!file) return 0;
  try {
    if (!fs.existsSync(file)) return 0;
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(arr)) return 0;
    arr.forEach(function (p) { if (p && p.masterProfileId) plans.set(p.masterProfileId, p); });
    return arr.length;
  } catch (_) { return 0; }
}


function now() { return Date.now(); }

/**
 * 创建（或覆盖）一个计划
 * @param {string} masterProfileId 主大脑
 * @param {string} goal 目标
 * @param {Array} modules [{id?,name?,desc?,deps?,acceptance?}]
 */
function createPlan(masterProfileId, goal, modules) {
  if (!masterProfileId) throw new Error('缺少 masterProfileId');
  const t = now();
  // 合并而非覆盖：按 id 保留已有模块的完成状态（防重复 plan_create 冲掉进度）
  const existing = plans.get(masterProfileId);
  const oldById = new Map();
  if (existing && Array.isArray(existing.modules)) {
    existing.modules.forEach(function (m) { oldById.set(m.id, m); });
  }
  const list = (Array.isArray(modules) ? modules : []).map(function (m, i) {
    const id = m.id || ('m' + (i + 1));
    const old = oldById.get(id);
    return {
      id: id,
      name: m.name || m.id || ('模块' + (i + 1)),
      desc: m.desc || '',
      deps: Array.isArray(m.deps) ? m.deps.slice() : [],
      acceptance: m.acceptance || '',
      status: old ? old.status : 'pending',
      assignee: old ? old.assignee : '',
      taskId: old ? old.taskId : '',
      result: old ? old.result : '',
      updatedAt: t,
    };
  });
  const plan = {
    masterProfileId: masterProfileId,
    goal: goal || '',
    modules: list,
    createdAt: (existing && existing.createdAt) || t,
    updatedAt: t,
    nudgeCount: (existing && existing.nudgeCount) || 0,
  };
  plans.set(masterProfileId, plan);
  refresh(plan);
  persist();
  return plan;
}

function getPlan(masterProfileId) {
  const p = plans.get(masterProfileId);
  if (p) refresh(p);
  return p || null;
}

/** 重算 ready/pending（依赖满足即可派） */
function refresh(plan) {
  if (!plan) return plan;
  const byId = new Map();
  plan.modules.forEach(function (m) { byId.set(m.id, m); });
  plan.modules.forEach(function (m) {
    // 超时兜底：assigned 模块若对应 task 长时间无活动 → 降级为 failed。
    // 以 task.updatedAt（任何状态变更/回报都会刷新）为准；查不到 task 则不动，避免误杀。
    if (m.status === 'assigned' && assignTimeoutMs > 0) {
      try {
        const tm = require('./task-manager');
        const task = m.taskId ? tm.getTask(m.taskId) : null;
        if (task && task.updatedAt) {
          const last = Date.parse(task.updatedAt) || 0;
          if (last && (Date.now() - last) > assignTimeoutMs) {
            m.status = 'failed';
            m.result = (m.result ? m.result + ' ' : '') + '[超时无活动，自动标记失败]';
            m.updatedAt = now();
            plan.updatedAt = now();
          }
        }
      } catch (_) { /* 查 task 失败：不动 */ }
      return;
    }
    if (m.status === 'assigned' || m.status === 'done' || m.status === 'failed' || m.status === 'skipped') return;
    const ok = m.deps.every(function (d) {
      const dm = byId.get(d);
      // 依赖模块不存在 → 视为未满足（保持 pending）。
      // 注意：不再"视为满足"——那会掩盖依赖写错/模块丢失的真问题。
      // 虚警的真根因（createPlan 覆盖丢模块）已由"合并"修复。
      if (!dm) return false;
      return dm.status === 'done' || dm.status === 'skipped';
    });
    m.status = ok ? 'ready' : 'pending';
  });
  return plan;
}

/** 列出「未全部完成」的计划 */
function listActivePlans() {
  const out = [];
  plans.forEach(function (p) {
    refresh(p);
    const allDone = p.modules.length > 0 && p.modules.every(function (m) {
      return m.status === 'done' || m.status === 'skipped';
    });
    if (!allDone) out.push(p);
  });
  return out;
}

/** 把一个已派发的 task 绑定到某个 ready 模块（按 module 名匹配，否则取第一个 ready） */
function bindTaskToReadyModule(masterProfileId, taskId, moduleHint) {
  const plan = getPlan(masterProfileId);
  if (!plan || !taskId) return null;
  let target = null;
  if (moduleHint) {
    target = plan.modules.find(function (m) { return m.status === 'ready' && (m.name === moduleHint || m.id === moduleHint); }) || null;
  }
  if (!target) target = plan.modules.find(function (m) { return m.status === 'ready'; }) || null;
  if (!target) return null;
  target.status = 'assigned';
  target.taskId = taskId;
  target.updatedAt = now();
  plan.updatedAt = now();
  persist();
  return target;
}

/** 按 taskId 标记完成 */
function markDoneByTaskId(taskId, result) {
  if (!taskId) return false;
  let hit = false;
  plans.forEach(function (plan) {
    const m = plan.modules.find(function (x) { return x.taskId === taskId; });
    if (m && m.status !== 'done') {
      m.status = 'done';
      m.result = result || '';
      m.updatedAt = now();
      plan.updatedAt = now();
      hit = true;
    }
  });
  return hit;
}

/** 按 taskId 标记失败 */
function markFailedByTaskId(taskId, reason) {
  if (!taskId) return false;
  let hit = false;
  plans.forEach(function (plan) {
    const m = plan.modules.find(function (x) { return x.taskId === taskId; });
    if (m) {
      m.status = 'failed';
      m.result = reason || '';
      m.updatedAt = now();
      plan.updatedAt = now();
      hit = true;
    }
  });
  return hit;
}

/** 手动把某模块标记为完成（用于模块由别的 task/人工完成、Task 无法自动联动的场景） */
function markModuleDone(masterProfileId, moduleId, result) {
  const plan = getPlan(masterProfileId);
  if (!plan || !moduleId) return null;
  const m = plan.modules.find(function (x) { return x.id === moduleId || x.name === moduleId; });
  if (!m) return null;
  m.status = 'done';
  m.result = result || '';
  m.updatedAt = now();
  plan.updatedAt = now();
  refresh(plan);
  persist();
  return m;
}

/** 生成计划摘要文本（供注入 Manager / 工具返回） */
function getSummary(plan) {
  if (!plan) return '';
  refresh(plan);
  const parts = [];
  parts.push('计划目标：' + (plan.goal || '(未填)'));
  const st = { done: 0, assigned: 0, ready: 0, pending: 0, failed: 0 };
  plan.modules.forEach(function (m) {
    if (st[m.status] !== undefined) st[m.status]++;
    const dep = m.deps.length ? '（依赖:' + m.deps.join(',') + '）' : '';
    parts.push('- [' + m.status + '] ' + m.name + dep + (m.assignee ? ' @' + m.assignee : ''));
  });
  parts.push('统计：完成 ' + st.done + ' / 进行中 ' + st.assigned + ' / 可派发 ' + st.ready + ' / 等待依赖 ' + st.pending + ' / 失败 ' + st.failed);
  return parts.join(NL);
}

/** 测试辅助：清空内存 + 删除落盘文件（保证测试隔离） */
function _reset() {
  plans.clear();
  try {
    const file = getPlanFile();
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch (_) {}
}
function clearPlan(masterProfileId) {
  const _r = plans.delete(masterProfileId);
  persist();
  return _r;
}

loadFromDisk();

module.exports = {
  createPlan,
  getPlan,
  refresh,
  listActivePlans,
  bindTaskToReadyModule,
  markDoneByTaskId,
  markFailedByTaskId,
  markModuleDone,
  _setAssignTimeoutMs,
  _getAssignTimeoutMs,
  getSummary,
  clearPlan,
  _reset,
  _plans: plans,
  loadFromDisk,
  persist,
};
