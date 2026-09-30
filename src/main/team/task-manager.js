/**
 * 任务管理器 - 维护主 AI 派发给 Worker 的任务状态
 *
 * 支持「总经理模式」：
 * - 多子 Agent 并行：每个任务记录 masterProfileId（派发者）、module（模块名）、waveId（波次）
 * - 分级汇报：SYNC（进度）/ DONE（完成）/ ASK（求助）
 * - 事件账本：append-only 记录每条回报，供压缩后重建团队状态
 *
 * 状态机：
 *   PENDING → DISPATCHED → RUNNING → WAITING_MASTER → COMPLETED
 *                            └────────────────────────→ FAILED / CANCELLED
 */
const fs = require('fs');
const path = require('path');
const { onWorkerResponse } = require('./response-bus');
const { getBaseDir } = require('../../core/agent-runtime/paths');

const tasks = new Map();

// ========== 持久化 ==========
// 任务写入 userData/tasks.json，重启后不丢失；落盘失败降级为仅内存（不抛错）。
const MAX_TASKS = 200; // 容量上限：最多保留 200 条，超出删最旧的
let FILE = null;

function getFile() {
  if (FILE) return FILE;
  try {
    FILE = path.join(getBaseDir(), 'tasks.json');
  } catch (e) {
    FILE = null; // 非 Electron 环境（如部分测试）降级为仅内存
  }
  return FILE;
}

/** 将内存任务落盘（超过容量上限则删最旧的）；失败静默降级，不抛错 */
function persist() {
  try {
    const f = getFile();
    if (!f) return false;
    let arr = Array.from(tasks.values());
    if (arr.length > MAX_TASKS) {
      arr.sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
      const remove = arr.slice(0, arr.length - MAX_TASKS);
      for (const t of remove) tasks.delete(t.id);
      arr = arr.slice(arr.length - MAX_TASKS);
    }
    fs.writeFileSync(f, JSON.stringify({ tasks: arr }, null, 2), 'utf-8');
    return true;
  } catch (e) {
    return false; // 落盘失败：仅保留内存状态，不抛错
  }
}

/**
 * 从磁盘恢复任务到内存 Map（模块加载时自动调用，也可供测试显式调用）
 * @returns {number} 恢复的任务条数
 */
function loadFromDisk() {
  try {
    const f = getFile();
    if (!f || !fs.existsSync(f)) return 0;
    const obj = JSON.parse(fs.readFileSync(f, 'utf-8'));
    const arr = obj && Array.isArray(obj.tasks) ? obj.tasks : [];
    let n = 0;
    for (const t of arr) {
      if (t && t.id) { tasks.set(t.id, t); n++; }
    }
    return n;
  } catch (e) {
    return 0;
  }
}

/**
 * 创建任务
 * @param {string} profileId 目标 Worker
 * @param {string} prompt 任务内容
 * @param {{module?:string, masterProfileId?:string, waveId?:string, sessionId?:string}} [opts]
 */
function createTask(profileId, prompt, opts = {}) {
  const taskId = 'task-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const now = new Date().toISOString();
  const task = {
    id: taskId,
    profileId,
    prompt,
    module: opts.module || '',
    masterProfileId: opts.masterProfileId || '',
    waveId: opts.waveId || '',
    sessionId: opts.sessionId || '', // 目标会话 ID（续派时可导航回原会话，上下文不丢）
    status: 'PENDING',
    result: null,
    progress: '',
    reports: [], // 事件账本（append-only）
    ackAt: null, // Worker 已确认收到任务的时刻（双向确认）；null 表示尚未收到 ack
    createdAt: now,
    updatedAt: now,
  };
  tasks.set(taskId, task);
  persist();
  return task;
}

function getTask(taskId) {
  return tasks.get(taskId) || null;
}

/**
 * 标记任务已被 Worker 确认收到（双向确认的 ack 落点）
 * @param {string} taskId
 * @returns {boolean} 任务存在则 true
 */
function markTaskAck(taskId) {
  const task = tasks.get(taskId);
  if (!task) return false;
  task.ackAt = new Date().toISOString();
  task.updatedAt = task.ackAt;
  persist();
  return true;
}

/**
 * 任务完成/失败时上报到指标层（metrics-store）。全 try/catch，失败静默。
 * @param {string} profileId Worker 的 profileId
 * @param {string} status 新状态
 */
function recordTaskMetrics(profileId, status) {
  if (status !== 'COMPLETED' && status !== 'FAILED') return;
  try {
    const metricsStore = require('../metrics-store');
    const delta = status === 'COMPLETED'
      ? { tasks: 1, success: 1 }
      : { tasks: 1, fail: 1 };
    metricsStore.record(profileId || '', delta);
  } catch (_) {
    /* 指标上报失败静默，绝不影响主流程 */
  }
}

function updateTaskStatus(taskId, status, result) {
  const task = tasks.get(taskId);
  if (!task) return;
  const prevStatus = task.status;
  task.status = status;
  if (result !== undefined && result !== null) task.result = result;
  task.updatedAt = new Date().toISOString();
  persist();
  // 指标上报：仅当状态实际变更到 COMPLETED/FAILED 时计一次，避免重复累加
  if (status !== prevStatus) recordTaskMetrics(task.profileId, status);
  // plan 联动：任务失败/取消时同步把绑定模块标记 failed，避免模块卡在 assigned 导致 plan 永不完成。
  // markFailedByTaskId 幂等，与 dispatch/window 中的显式调用重复也无害。
  if (status !== prevStatus && (status === 'FAILED' || status === 'CANCELLED')) {
    try { require('./plan').markFailedByTaskId(taskId, result || status); } catch (_) {}
  }
  // todo 收尾：任务进入终态（完成/失败/取消）时，把该 Worker 遗留的未完成 todo 全部标记 completed，
  // 避免进程胶囊因某个 in_progress 永远"工作中"（计时不停、进度不同步）。
  if (status !== prevStatus && (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED')) {
    try {
      const todoStore = require('../todo-store');
      const cur = todoStore.getTodos(task.profileId);
      if (cur && Array.isArray(cur.list) && cur.list.length) {
        todoStore.setTodos(task.profileId, cur.list.map(function (t) {
          return { content: t.content, status: 'completed' };
        }));
      }
    } catch (_) { /* 收尾失败静默，不影响主流程 */ }
  }
}

/**
 * 追加一条回报到事件账本
 * @param {string} taskId
 * @param {{level:string, content:string, ts?:string}} report
 */
function appendReport(taskId, report) {
  const task = tasks.get(taskId);
  if (!task) return;
  task.reports.push({
    level: report.level || 'SYNC',
    content: report.content || '',
    ts: report.ts || new Date().toISOString(),
  });
  if (report.content) task.progress = report.content;
  task.updatedAt = new Date().toISOString();
  persist();
}

/**
 * 列出任务（可按 masterProfileId / status / waveId 过滤）
 */
function listTasks(filter = {}) {
  let arr = Array.from(tasks.values());
  if (filter.masterProfileId) arr = arr.filter((t) => t.masterProfileId === filter.masterProfileId);
  if (filter.status) arr = arr.filter((t) => t.status === filter.status);
  if (filter.waveId) arr = arr.filter((t) => t.waveId === filter.waveId);
  return arr;
}

/** 该 profile 是否正作为某个活跃任务的 Worker（用于"叶子"限制） */
function isWorkerProfile(profileId) {
  if (!profileId) return false;
  const active = ['PENDING', 'DISPATCHED', 'RUNNING', 'WAITING_MASTER'];
  for (const t of tasks.values()) {
    if (t.profileId === profileId && active.indexOf(t.status) !== -1) return true;
  }
  return false;
}

/** 按 worker profileId 查它最近一次任务（用于 session 模式取上次绑定的会话 ID） */
function getLatestTaskByProfile(profileId) {
  if (!profileId) return null;
  let latest = null;
  for (const t of tasks.values()) {
    if (t.profileId !== profileId) continue;
    if (!latest) { latest = t; continue; }
    if ((Date.parse(t.createdAt) || 0) > (Date.parse(latest.createdAt) || 0)) latest = t;
  }
  return latest;
}

/** 按 worker profileId 查它的活跃任务（用于登录失效时定位回报目标） */
function getActiveTaskByProfile(profileId) {
  if (!profileId) return null;
  const active = ['PENDING', 'DISPATCHED', 'RUNNING', 'WAITING_MASTER'];
  for (const t of tasks.values()) {
    if (t.profileId === profileId && active.indexOf(t.status) !== -1) return t;
  }
  return null;
}

/** 某主大脑下仍"在跑"的任务（DISPATCHED / RUNNING / WAITING_MASTER / PENDING） */
function listActiveTasks(masterProfileId) {
  const active = ['PENDING', 'DISPATCHED', 'RUNNING', 'WAITING_MASTER'];
  return listTasks({ masterProfileId }).filter((t) => active.indexOf(t.status) !== -1);
}

// 兼容旧的 worker-response 事件（无分级信息时兜底标记完成）
onWorkerResponse((payload) => {
  const taskId = payload.taskId;
  if (!taskId || !tasks.has(taskId)) return;
  const task = tasks.get(taskId);
  if (task.status === 'DISPATCHED' || task.status === 'RUNNING' || task.status === 'PENDING') {
    updateTaskStatus(taskId, 'COMPLETED', payload.text);
    console.log('[TaskManager] Task ' + taskId + ' completed (legacy). Length: ' + (payload.text || '').length);
  }
});

const inbox = new Map();
function addInbox(taskId, content) { inbox.set(taskId, content); }
function getInbox(taskId) { const c = inbox.get(taskId); if (c) { inbox.delete(taskId); return c; } return null; }

// 模块加载时从盘恢复（失败静默降级为仅内存）
loadFromDisk();

/** 测试辅助：清空内存并落盘 */
function _reset() { tasks.clear(); persist(); }

module.exports = {
  createTask,
  getTask,
  markTaskAck,
  updateTaskStatus,
  appendReport,
  listTasks,
  listActiveTasks,
  isWorkerProfile,
  getLatestTaskByProfile,
  getActiveTaskByProfile,
  loadFromDisk,
  _reset,
  tasks,
  addInbox,
  getInbox,
};
