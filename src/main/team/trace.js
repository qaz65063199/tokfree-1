/**
 * 执行轨迹记录（Trace）—— Agent 自工程化（自写/自修复/自迭代）的地基
 *
 * 记录每次任务执行的完整轨迹：每一步工具调用的输入、输出、耗时、错误。
 * 这是「执行 → 复盘 → 优化 → 再执行」进化飞轮的原料（Level 1 核心）。
 *
 * 存储：
 *   userData/traces/<taskId>.json  单任务一个轨迹文件
 *   userData/traces/index.json     索引（taskId -> 摘要，便于列表/淘汰）
 *
 * 容量：最多 MAX_TRACES 个轨迹，超出按时间淘汰最旧。
 *
 * 纯记录模块：不改变任何工具行为，失败静默（绝不影响主流程）。
 */
const fs = require('fs');
const path = require('path');
const { getBaseDir } = require('../../core/agent-runtime/paths');

const MAX_TRACES = 100;
const MAX_STEPS_PER_TRACE = 500;
const MAX_FIELD_LEN = 2000;

let TRACE_DIR = null;
function getTraceDir() {
  if (!TRACE_DIR) {
    TRACE_DIR = path.join(getBaseDir(), 'traces');
    if (!fs.existsSync(TRACE_DIR)) fs.mkdirSync(TRACE_DIR, { recursive: true });
  }
  return TRACE_DIR;
}

function safeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function traceFile(taskId) {
  return path.join(getTraceDir(), safeId(taskId) + '.json');
}

function indexFile() {
  return path.join(getTraceDir(), 'index.json');
}

// 内存活跃轨迹：taskId -> trace
const active = new Map();

// ========== 自动落盘（关键：无需外部调 endTrace 也能落盘）==========
// 每次 recordStep 后重置一个「静默计时器」；某轨迹静默 IDLE_FLUSH_MS 后自动落盘。
// 这样"一段连续活动"自动成为一条轨迹，不依赖外部触发（任务结束事件）。
const IDLE_FLUSH_MS = 12000;
const idleTimers = new Map(); // traceKey -> timer

function scheduleIdleFlush(taskId) {
  if (!taskId) return;
  const old = idleTimers.get(taskId);
  if (old) clearTimeout(old);
  const timer = setTimeout(function () {
    idleTimers.delete(taskId);
    try {
      if (active.has(taskId)) {
        console.log('[Trace] 静默 ' + (IDLE_FLUSH_MS / 1000) + 's，自动落盘轨迹: ' + taskId);
        endTrace(taskId, {});
      }
    } catch (e) {}
  }, IDLE_FLUSH_MS);
  if (timer.unref) timer.unref();
  idleTimers.set(taskId, timer);
}

/** 截断长字段，避免轨迹文件爆炸 */
function truncate(v) {
  if (v === null || v === undefined) return v;
  var s;
  if (typeof v === 'string') s = v;
  else {
    try { s = JSON.stringify(v); } catch (e) { s = String(v); }
  }
  if (s.length > MAX_FIELD_LEN) return s.slice(0, MAX_FIELD_LEN) + '...[截断]';
  return s;
}

// ========== 层级化（借鉴 OpenTelemetry span 父子模型）==========
// 每个 step 带 id/parentId/type，存储仍是扁平数组（不嵌套）；旧数据缺字段时按默认值补齐。
var DEFAULT_STEP_TYPE = 'event'; // 缺省类型（旧数据归一化 + recordStep 未显式指定时）

/** 把单个 step 归一化为带层级字段的标准结构（幂等，向后兼容旧数据） */
function normalizeStep(s, idx) {
  var step = (s && typeof s === 'object') ? s : {};
  var seq = typeof step.seq === 'number' ? step.seq : (idx + 1);
  return {
    id: step.id || ('s' + seq),
    seq: seq,
    parentId: (step.parentId !== undefined && step.parentId !== null) ? step.parentId : null,
    type: step.type || DEFAULT_STEP_TYPE,
    ts: step.ts || null,
    tool: step.tool || '',
    args: step.args,
    success: step.success !== false,
    error: step.error || '',
    durationMs: typeof step.durationMs === 'number' ? step.durationMs : 0,
    outputSize: typeof step.outputSize === 'number' ? step.outputSize : null,
  };
}

/** 归一化整条轨迹的 steps（读取时调用，兼容旧 trace） */
function normalizeTrace(t) {
  if (!t || typeof t !== 'object') return t;
  if (Array.isArray(t.steps)) {
    t.steps = t.steps.map(normalizeStep);
  }
  return t;
}

function readIndex() {
  try {
    var f = indexFile();
    if (!fs.existsSync(f)) return { traces: [] };
    var obj = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if (obj && Array.isArray(obj.traces)) return obj;
  } catch (e) {}
  return { traces: [] };
}

function writeIndex(obj) {
  try {
    fs.writeFileSync(indexFile(), JSON.stringify(obj, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[Trace] 写索引失败:', e.message);
    return false;
  }
}

/**
 * 开始记录一个任务的轨迹
 * @param {string} taskId
 * @param {{profileId?:string, goal?:string}} [opts]
 */
function beginTrace(taskId, opts) {
  if (!taskId) return null;
  var o = opts || {};
  var trace = {
    taskId: taskId,
    profileId: o.profileId || '',
    goal: truncate(o.goal || ''),
    startedAt: new Date().toISOString(),
    endedAt: null,
    steps: [],
    outcome: null,
    summary: '',
  };
  active.set(taskId, trace);
  return trace;
}

/** 取活跃轨迹；若无则从磁盘读 */
function getTrace(taskId) {
  if (!taskId) return null;
  if (active.has(taskId)) return active.get(taskId);
  try {
    var f = traceFile(taskId);
    if (fs.existsSync(f)) return normalizeTrace(JSON.parse(fs.readFileSync(f, 'utf-8')));
  } catch (e) {}
  return null;
}

/**
 * 记录一步（工具调用）
 * @param {string} taskId
 * @param {{tool:string, args?:any, success?:boolean, error?:string, durationMs?:number, outputSize?:number, type?:string, parentId?:string|null, id?:string}} step
 * @param {string|null} [parentId] 父 step 的 id（层级化用；也可写在 step.parentId 里）
 */
function recordStep(taskId, step, parentId) {
  if (!taskId || !step) return false;
  var t = active.get(taskId);
  if (!t) {
    // 未显式 begin 也允许记录（自动补建）
    t = beginTrace(taskId, { profileId: step.profileId || '' });
    if (!t) return false;
  }
  if (t.steps.length >= MAX_STEPS_PER_TRACE) {
    // 超限：只记计数
    t.truncated = (t.truncated || 0) + 1;
    return false;
  }
  var seq = t.steps.length + 1;
  // 父 id 优先取显式参数，其次取 step.parentId；缺省为根（null）
  var pid = (parentId !== undefined && parentId !== null) ? parentId
    : ((step.parentId !== undefined && step.parentId !== null) ? step.parentId : null);
  t.steps.push({
    id: step.id || ('s' + seq),
    seq: seq,
    parentId: pid,
    type: step.type || DEFAULT_STEP_TYPE,
    ts: new Date().toISOString(),
    tool: step.tool || '',
    args: truncate(step.args),
    success: step.success !== false,
    error: step.error ? truncate(step.error) : '',
    durationMs: typeof step.durationMs === 'number' ? step.durationMs : 0,
    outputSize: typeof step.outputSize === 'number' ? step.outputSize : null,
  });
  // 自动落盘：重置静默计时器
  scheduleIdleFlush(taskId);
  return true;
}

/**
 * 结束轨迹并落盘
 * @param {string} taskId
 * @param {{outcome?:string, summary?:string}} [opts]
 */
function endTrace(taskId, opts) {
  var o = opts || {};
  var t = active.get(taskId);
  if (!t) return false;
  t.endedAt = new Date().toISOString();
  t.outcome = o.outcome || inferOutcome(t);
  t.summary = truncate(o.summary || '');
  try {
    fs.writeFileSync(traceFile(taskId), JSON.stringify(t, null, 2), 'utf-8');
    // 更新索引
    var idx = readIndex();
    var stepCount = t.steps.length;
    var errCount = t.steps.filter(function (s) { return s.success === false; }).length;
    var durMs = Date.parse(t.endedAt) - Date.parse(t.startedAt);
    idx.traces = idx.traces.filter(function (x) { return x.taskId !== taskId; });
    idx.traces.push({
      taskId: taskId,
      profileId: t.profileId,
      goal: t.goal,
      outcome: t.outcome,
      stepCount: stepCount,
      errorCount: errCount,
      durationMs: durMs,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
    });
    // 淘汰最旧
    if (idx.traces.length > MAX_TRACES) {
      idx.traces.sort(function (a, b) { return Date.parse(a.startedAt) - Date.parse(b.startedAt); });
      var removed = idx.traces.splice(0, idx.traces.length - MAX_TRACES);
      removed.forEach(function (r) {
        try { fs.unlinkSync(traceFile(r.taskId)); } catch (e) {}
      });
    }
    writeIndex(idx);
  } catch (e) {
    console.error('[Trace] 落盘失败:', e.message);
  }
  active.delete(taskId);
  return true;
}

/** 根据步骤推断结果 */
function inferOutcome(t) {
  if (!t || !t.steps || t.steps.length === 0) return 'empty';
  var errs = t.steps.filter(function (s) { return s.success === false; }).length;
  if (errs === 0) return 'success';
  if (errs === t.steps.length) return 'failed';
  return 'partial';
}

/** 列出轨迹摘要 */
function listTraces(limit) {
  var idx = readIndex();
  var arr = idx.traces.slice().sort(function (a, b) {
    return Date.parse(b.startedAt) - Date.parse(a.startedAt);
  });
  return typeof limit === 'number' && limit > 0 ? arr.slice(0, limit) : arr;
}

/** 清空所有轨迹（调试用） */
function clearAll() {
  active.clear();
  try {
    var dir = getTraceDir();
    var files = fs.readdirSync(dir);
    for (var i = 0; i < files.length; i++) {
      try { fs.unlinkSync(path.join(dir, files[i])); } catch (e) {}
    }
    writeIndex({ traces: [] });
  } catch (e) {}
  return true;
}

/** 是否有活跃轨迹 */
function hasActive(taskId) {
  return active.has(taskId);
}

module.exports = {
  beginTrace,
  recordStep,
  endTrace,
  getTrace,
  listTraces,
  clearAll,
  hasActive,
  MAX_TRACES,
  MAX_STEPS_PER_TRACE,
};
