/**
 * 观察日志（Observational Memory，借鉴 Mastra 的 Observer/Reflector 两层记忆）
 *
 * 与 compaction.js（上下文压缩，摘要式）互补而非替代：
 *   - 压缩：把整段对话压成一份交接摘要，用于"续接"。
 *   - 观察日志：AI 在对话中主动产出的结构化观察（决策/偏好/踩坑/待办/上下文），
 *     长期沉淀、跨会话注入，让新会话不必重新"摸索"。
 *
 * 存储：userData/observations/<profileId>.json
 *   { observations: [{ id, category, summary, source, ts }], reflections: [{ id, summary, ts }] }
 *
 * 两层记忆：
 *   - observation：Observer（观察者，多 Agent 模式下由主 Agent 承担）在对话中逐条记录。
 *   - reflection：Reflector（反思者）在 observation 累积到阈值时，做一次【AI 语义合并】，
 *     产出更高层的反思/结论。
 *
 * 合并设计（重要）：
 *   主进程不能直接调 AI，因此 mergeObservations(profileId, aiMerge) 接受一个可选回调：
 *     - aiMerge 由上层（能调 AI 的一方）传入，签名 (observations, reflections) => string
 *       返回应含 <reflection>...</reflection> 块。
 *     - 未传回调时，仅返回「需要合并」的信号（needsMerge: true），由调用方决定下一步。
 *   这样本模块保持纯本地、零 AI 依赖，同时把"何时合并 / 合并什么"的决策交给上层。
 *
 * 接口/容错风格参考 src/main/lessons.js。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

/** 观察条数上限，超出淘汰最旧 */
const MAX_OBSERVATIONS = 50;
/** 反思条数上限，超出淘汰最旧 */
const MAX_REFLECTIONS = 20;
/** 触发 Reflector 合并的 observations 数阈值 */
const DEFAULT_MERGE_THRESHOLD = 20;

/** category 合法取值 */
const VALID_CATEGORIES = ['决策', '偏好', '踩坑', '待办', '上下文'];

// ========== 路径 ==========

function getObsDir() {
  const dir = path.join(app.getPath('userData'), 'observations');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getObsFile(profileId) {
  const safe = String(profileId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
  return path.join(getObsDir(), safe + '.json');
}

/** 把损坏文件改名备份，避免静默覆盖造成"数据丢失"错觉 */
function backupCorruptFile(file, reason) {
  try {
    if (!fs.existsSync(file)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(file, file + '.corrupt-' + stamp);
    console.error('[Observations] 文件损坏已备份(' + reason + '):', file);
  } catch (e) {
    console.error('[Observations] 备份损坏文件失败:', e.message);
  }
}

// ========== 读写 ==========

function emptyStore() {
  return { observations: [], reflections: [] };
}

function readStore(profileId) {
  const f = getObsFile(profileId);
  if (!fs.existsSync(f)) return emptyStore();
  try {
    const obj = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if (obj && Array.isArray(obj.observations) && Array.isArray(obj.reflections)) {
      return obj;
    }
    backupCorruptFile(f, '结构非法');
  } catch (err) {
    console.error('[Observations] 读取失败:', err.message);
    backupCorruptFile(f, 'JSON 解析失败');
  }
  return emptyStore();
}

function writeStore(profileId, obj) {
  try {
    fs.writeFileSync(getObsFile(profileId), JSON.stringify(obj, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[Observations] 写入失败:', err.message);
    return false;
  }
}

// ========== 工具函数 ==========

function genId(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

/** 保留最近 N 条（按 ts 升序排列后取尾部） */
function keepRecent(arr, max) {
  if (!Array.isArray(arr)) return [];
  if (arr.length <= max) return arr;
  const sorted = arr.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return sorted.slice(sorted.length - max);
}

/** 校验/归一 category，非法返回 null */
function normalizeCategory(cat) {
  const c = String(cat || '').trim();
  return VALID_CATEGORIES.includes(c) ? c : null;
}

/** 从字段块中提取 <name>value</name> 或 "name: value" 形式的值 */
function extractField(body, name) {
  const tagRe = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>', 'i');
  const tm = body.match(tagRe);
  if (tm && tm[1]) return tm[1].trim();
  const lineRe = new RegExp('(?:^|\\n)\\s*' + name + '\\s*[:：]\\s*(.+)', 'i');
  const lm = body.match(lineRe);
  if (lm && lm[1]) return lm[1].trim();
  return '';
}

// ========== 解析 ==========

/**
 * 从 AI 回复文本中提取 <observation>...</observation> 块。
 * 先剔除 Markdown 代码围栏（用 \x60 表示反引号），避免抓到代码里的示例。
 * 每个块解析 category / summary / source 字段。
 * @param {string} text
 * @returns {Array<{category, summary, source}>}
 */
function parseObservations(text) {
  if (!text || typeof text !== 'string') return [];
  const clean = text.replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60/g, '');
  const results = [];
  const re = /<observation>([\s\S]*?)<\/observation>/gi;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const body = m[1] || '';
    const category = normalizeCategory(extractField(body, 'category'));
    const summary = extractField(body, 'summary');
    if (!category || !summary) continue;
    const source = extractField(body, 'source');
    results.push({ category, summary, source: source || '' });
  }
  return results;
}

/**
 * 从 AI 回复中提取 <reflection>...</reflection> 块（供 Reflector 合并结果解析）。
 * @param {string} text
 * @returns {string[]} 反思摘要数组
 */
function parseReflections(text) {
  if (!text || typeof text !== 'string') return [];
  const clean = text.replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60/g, '');
  const results = [];
  const re = /<reflection>([\s\S]*?)<\/reflection>/gi;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const body = (m[1] || '').trim();
    if (!body) continue;
    const summary = extractField(body, 'summary') || body;
    if (summary) results.push(summary);
  }
  return results;
}

// ========== 对外接口 ==========

/**
 * 追加一条观察记录
 * @param {string} profileId
 * @param {{category, summary, source}} obs
 * @returns {{success: boolean, id?: string, error?: string}}
 */
function addObservation(profileId, obs) {
  try {
    const { category, summary, source } = obs || {};
    const cat = normalizeCategory(category);
    if (!cat) return { success: false, error: '非法 category（须为：' + VALID_CATEGORIES.join('|') + '）' };
    if (!summary || !String(summary).trim()) return { success: false, error: 'summary 不能为空' };
    const db = readStore(profileId);
    const rec = {
      id: genId('obs'),
      category: cat,
      summary: String(summary).trim(),
      source: source ? String(source) : '',
      ts: Date.now(),
    };
    db.observations.push(rec);
    db.observations = keepRecent(db.observations, MAX_OBSERVATIONS);
    if (!writeStore(profileId, db)) return { success: false, error: '写入失败' };
    return { success: true, id: rec.id };
  } catch (err) {
    console.error('[Observations] addObservation 失败:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 列出观察记录（最近 limit 条，按时间升序）
 * @param {string} profileId
 * @param {number} [limit=10]
 */
function listObservations(profileId, limit = 10) {
  try {
    const all = readStore(profileId).observations;
    const lim = Number.isInteger(limit) && limit > 0 ? limit : 10;
    if (all.length <= lim) return all.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const sorted = all.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return sorted.slice(sorted.length - lim);
  } catch (err) {
    console.error('[Observations] listObservations 失败:', err.message);
    return [];
  }
}

/**
 * 追加一条反思记录
 * @param {string} profileId
 * @param {string} summary
 */
function addReflection(profileId, summary) {
  try {
    if (!summary || !String(summary).trim()) return { success: false, error: 'summary 不能为空' };
    const db = readStore(profileId);
    const rec = { id: genId('ref'), summary: String(summary).trim(), ts: Date.now() };
    db.reflections.push(rec);
    db.reflections = keepRecent(db.reflections, MAX_REFLECTIONS);
    if (!writeStore(profileId, db)) return { success: false, error: '写入失败' };
    return { success: true, id: rec.id };
  } catch (err) {
    console.error('[Observations] addReflection 失败:', err.message);
    return { success: false, error: err.message };
  }
}

/** 列出全部反思记录（按时间升序） */
function listReflections(profileId) {
  try {
    const all = readStore(profileId).reflections;
    return all.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  } catch (err) {
    console.error('[Observations] listReflections 失败:', err.message);
    return [];
  }
}

/**
 * Reflector：observations 数 >= 阈值时触发【AI 语义合并】。
 *
 * 两种用法：
 *   1) mergeObservations(profileId, aiMerge)
 *      aiMerge(observations, reflections) => string（含 <reflection> 块）
 *      -> 调用回调，解析反思并入库，合并后的 observations 被移除。
 *      返回 { merged: true, added: N, reflections: [...] }。
 *   2) mergeObservations(profileId)（无回调）
 *      -> 仅返回信号 { needsMerge: true, count, observations }，由调用方决定。
 *
 * @param {string} profileId
 * @param {Function} [aiMerge] 可选的 AI 合并回调
 * @returns {object}
 */
function mergeObservations(profileId, aiMerge) {
  try {
    let mergeFn = aiMerge;
    if (typeof aiMerge === 'number') mergeFn = null;
    const db = readStore(profileId);
    const obs = db.observations || [];
    if (obs.length < DEFAULT_MERGE_THRESHOLD) {
      return { merged: false, needsMerge: false, count: obs.length };
    }

    if (typeof mergeFn !== 'function') {
      return {
        merged: false,
        needsMerge: true,
        count: obs.length,
        threshold: DEFAULT_MERGE_THRESHOLD,
        observations: obs.slice(),
        reflections: (db.reflections || []).slice(),
      };
    }

    let raw = '';
    try {
      raw = mergeFn(obs.slice(), (db.reflections || []).slice());
    } catch (e) {
      console.error('[Observations] aiMerge 回调失败:', e && e.message);
      return { merged: false, error: e && e.message };
    }

    const summaries = parseReflections(raw || '');
    if (summaries.length === 0) {
      return { merged: false, error: 'AI 未返回有效 <reflection> 内容' };
    }
    for (const s of summaries) {
      db.reflections.push({ id: genId('ref'), summary: s, ts: Date.now() });
    }
    db.reflections = keepRecent(db.reflections, MAX_REFLECTIONS);
    db.observations = [];
    if (!writeStore(profileId, db)) return { merged: false, error: '写入失败' };
    return { merged: true, added: summaries.length, reflections: summaries };
  } catch (err) {
    console.error('[Observations] mergeObservations 失败:', err.message);
    return { merged: false, error: err.message };
  }
}

/**
 * 把内存中的观察数据落盘（本模块每条写入即落盘，flush 为兼容性空操作）。
 * @returns {boolean}
 */
function flush() {
  return true;
}

module.exports = {
  MAX_OBSERVATIONS,
  MAX_REFLECTIONS,
  DEFAULT_MERGE_THRESHOLD,
  VALID_CATEGORIES,
  getObsDir,
  getObsFile,
  parseObservations,
  parseReflections,
  addObservation,
  listObservations,
  addReflection,
  listReflections,
  mergeObservations,
  flush,
};
