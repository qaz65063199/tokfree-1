'use strict';
/**
 * 定时任务（Scheduled Tasks）—— 轻量模块（借鉴 DeerFlow Scheduled Tasks）
 *
 * 定位：用户可创建 / 启停 / 删除的定时任务；到点向指定窗口注入一段 prompt。
 *
 * 任务模型（持久化于 userData/scheduled-tasks.json）：
 *   { tasks: [{ id, name, prompt, profileId, type: 'once' | 'interval',
 *               atMs?, intervalMinutes?, enabled, lastRunAt, runCount, createdAt }] }
 *
 * 执行 = 复用 Agent Runtime 注入端口 inject(profileId, message, ctx)：
 *   - task.profileId 指定 → 用该窗口；
 *   - 否则用主窗口（windowState.getMainContext()）。
 *
 * 本模块只负责「闹钟」，不做任何 AI 思考（与引导者 curator 同思路）。
 */
const fs = require('fs');
const path = require('path');
const { getBaseDir } = require('../core/agent-runtime/paths');
const { inject: injectMessage } = require('../core/agent-runtime/inject');

const TICK_MS = 30000; // 每 30 秒检查一次
let tasks = [];
let filePath = null;
let timer = null;

/** 任务文件路径（惰性，参照 curator 的 getConfigFile） */
function getFilePath() {
  if (!filePath) filePath = path.join(getBaseDir(), 'scheduled-tasks.json');
  return filePath;
}

/** 生成任务 id（时间戳 + 随机串，避免同毫秒碰撞） */
function genId() {
  return 'st-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/** 从磁盘加载（损坏 JSON 容错：重置为空） */
function loadTasks() {
  try {
    const f = getFilePath();
    if (fs.existsSync(f)) {
      const raw = fs.readFileSync(f, 'utf-8');
      const obj = JSON.parse(raw);
      if (obj && Array.isArray(obj.tasks)) {
        tasks = obj.tasks.filter(function (t) { return t && typeof t === 'object'; });
      } else {
        tasks = [];
      }
    } else {
      tasks = [];
    }
  } catch (e) {
    console.error('[ScheduledTasks] 读取失败，重置为空:', e.message);
    tasks = [];
  }
  return tasks;
}

/** 写回磁盘 */
function saveTasks() {
  try {
    fs.writeFileSync(getFilePath(), JSON.stringify({ tasks: tasks }, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[ScheduledTasks] 写入失败:', e.message);
    return false;
  }
}

/** 规范化创建参数（纯函数，便于测试） */
function normalizeTask(opts) {
  const o = opts || {};
  const type = o.type === 'once' ? 'once' : 'interval';
  const task = {
    id: o.id || genId(),
    name: String(o.name || '').trim() || '未命名定时任务',
    prompt: String(o.prompt || ''),
    profileId: String(o.profileId || ''),
    type: type,
    enabled: o.enabled === false ? false : true,
    lastRunAt: 0,
    runCount: 0,
    createdAt: Date.now(),
  };
  if (type === 'once') {
    const at = parseInt(o.atMs, 10);
    task.atMs = Number.isFinite(at) ? at : Date.now();
  } else {
    const mins = parseInt(o.intervalMinutes, 10);
    task.intervalMinutes = (Number.isFinite(mins) && mins > 0) ? mins : 30;
  }
  return task;
}

/** 创建任务 */
function createTask(opts) {
  loadTasks();
  const t = normalizeTask(opts);
  tasks.push(t);
  saveTasks();
  return t;
}

/** 列出全部任务（拷贝，避免外部改内部状态） */
function listTasks() {
  loadTasks();
  return tasks.map(function (t) { return Object.assign({}, t); });
}

/** 删除任务（找不到返回 false） */
function removeTask(id) {
  loadTasks();
  const idx = tasks.findIndex(function (t) { return t.id === id; });
  if (idx < 0) return false;
  tasks.splice(idx, 1);
  saveTasks();
  return true;
}

/** 启停任务（找不到返回 false） */
function toggleTask(id, enabled) {
  loadTasks();
  const t = tasks.find(function (x) { return x.id === id; });
  if (!t) return false;
  t.enabled = !!enabled;
  saveTasks();
  return true;
}

/**
 * 任务是否到期（纯函数，便于测试）。
 * @param {object} task
 * @param {number} now 当前时间戳
 * @returns {boolean}
 */
function isDue(task, now) {
  if (!task || task.enabled !== true) return false;
  const t = typeof now === 'number' ? now : Date.now();
  if (task.type === 'once') {
    if (typeof task.atMs !== 'number' || !Number.isFinite(task.atMs)) return false;
    return t >= task.atMs;
  }
  if (task.type === 'interval') {
    const mins = Number(task.intervalMinutes);
    if (!Number.isFinite(mins) || mins <= 0) return false;
    const base = task.lastRunAt || task.createdAt || 0;
    return (t - base) >= mins * 60000;
  }
  return false;
}

/** 解析任务要注入的目标窗口 ctx */
function resolveTargetContext(task) {
  try {
    const windowState = require('./window');
    if (task && task.profileId) return windowState.getWindowByProfileId(task.profileId);
    return windowState.getMainContext();
  } catch (_) {
    return null;
  }
}

/** 执行单个任务：向目标窗口注入 prompt（全 try/catch，绝不抛） */
function runTask(task) {
  try {
    const ctx = resolveTargetContext(task);
    const pid = (task && task.profileId) || (ctx && ctx.profileId) || '';
    if (!pid) {
      console.log('[ScheduledTasks] 无可用目标窗口，跳过: ' + (task && task.id));
      return { ok: false, error: '无可用目标窗口' };
    }
    injectMessage(pid, task.prompt || '', ctx || undefined);
    console.log('[ScheduledTasks] 已注入任务 ' + task.id + ' -> ' + pid);
    return { ok: true, profileId: pid };
  } catch (e) {
    console.error('[ScheduledTasks] 注入失败:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * 一次 tick：检查所有任务，到期的执行。
 * @param {number} [now] 可选，注入当前时间（便于测试）
 * @returns {Array<{id, ok, error?}>} 本轮执行结果
 */
function tick(now) {
  loadTasks();
  const t = typeof now === 'number' ? now : Date.now();
  const results = [];
  let changed = false;
  for (const task of tasks) {
    if (!isDue(task, t)) continue;
    const r = runTask(task);
    results.push({ id: task.id, ok: r.ok, error: r.error });
    task.lastRunAt = t;
    task.runCount = (task.runCount || 0) + 1;
    if (task.type === 'once') task.enabled = false;
    changed = true;
  }
  if (changed) saveTasks();
  return results;
}

/** 启动定时器（幂等） */
function start(opts) {
  loadTasks();
  if (timer) return { started: false, reason: '已在运行' };
  const tickMs = (opts && typeof opts.tickMs === 'number' && opts.tickMs > 0) ? opts.tickMs : TICK_MS;
  timer = setInterval(function () {
    try { tick(); } catch (e) { console.error('[ScheduledTasks] tick 异常:', e.message); }
  }, tickMs);
  if (timer.unref) timer.unref();
  console.log('[ScheduledTasks] 定时任务模块已启动，tick=' + (tickMs / 1000) + 's, 任务数=' + tasks.length);
  return { started: true, tickMs: tickMs };
}

/** 停止定时器 */
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

/** 测试用：重置内存状态并删除持久化文件（保证测试隔离） */
function _reset() {
  stop();
  tasks = [];
  try {
    const f = getFilePath();
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch (_) {}
}

module.exports = {
  genId,
  getFilePath,
  normalizeTask,
  isDue,
  loadTasks,
  saveTasks,
  createTask,
  listTasks,
  removeTask,
  toggleTask,
  resolveTargetContext,
  runTask,
  tick,
  start,
  stop,
  _reset,
};
