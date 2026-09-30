/**
 * 教训记忆（Reflexion 式自进化，跨项目共享）
 *
 * 解决痛点：任务失败/被用户纠正后学到的东西没有沉淀，下次同类任务重蹈覆辙。
 * 与 MemPalace（按需检索）不同，教训由 project-context 在初始化时"主动注入"，
 * 确保 AI 一定看到，从而越用越聪明。
 *
 * 存储：userData/knowledge/lessons.json
 *   { lessons: [{ id, lesson, context, tags, scope, projectDir, createdAt, hits }] }
 *
 * scope：'global'（跨项目，按 tags 与关键词匹配度排序注入）
 *        或 <projectDir>（项目专属，全部注入）
 *
 * 接口设计参考 src/main/knowledge.js（容错、损坏备份等）。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

/** 教训条数上限，超出按 (hits 低 + 久未命中) 淘汰 */
const MAX_LESSONS = 200;

// ========== 路径 ==========

function getKnowledgeDir() {
  const dir = path.join(app.getPath('userData'), 'knowledge');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getLessonsFile() {
  return path.join(getKnowledgeDir(), 'lessons.json');
}

/** 把损坏文件改名备份，避免静默覆盖造成"数据丢失"错觉 */
function backupCorruptFile(file, reason) {
  try {
    if (!fs.existsSync(file)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(file, file + '.corrupt-' + stamp);
    console.error('[Lessons] 文件损坏已备份(' + reason + '):', file);
  } catch (e) {
    console.error('[Lessons] 备份损坏文件失败:', e.message);
  }
}

// ========== 读写 ==========

function readLessons() {
  const f = getLessonsFile();
  if (!fs.existsSync(f)) return { lessons: [] };
  try {
    const obj = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if (obj && Array.isArray(obj.lessons)) return obj;
    backupCorruptFile(f, '结构非法');
  } catch (err) {
    console.error('[Lessons] 读取教训失败:', err.message);
    backupCorruptFile(f, 'JSON 解析失败');
  }
  return { lessons: [] };
}

function writeLessons(obj) {
  try {
    fs.writeFileSync(getLessonsFile(), JSON.stringify(obj, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[Lessons] 写入教训失败:', err.message);
    return false;
  }
}

// ========== 工具函数 ==========

function genId() {
  return 'lsn-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t)).filter(Boolean);
  if (tags === undefined || tags === null || tags === '') return [];
  return [String(tags)];
}

/**
 * 淘汰：超过 MAX_LESSONS 时，按 (hits 低 + 久未命中) 优先淘汰。
 * 无 lastHitAt 字段，以 createdAt 近似"久未命中"（越旧越先淘汰）。
 */
function evict(lessons) {
  if (lessons.length <= MAX_LESSONS) return lessons;
  const sorted = lessons.slice().sort((a, b) => {
    const ha = a.hits || 0;
    const hb = b.hits || 0;
    if (ha !== hb) return ha - hb;                       // hits 低者先淘汰
    return (a.createdAt || 0) - (b.createdAt || 0);      // 越旧越先淘汰
  });
  const removeCount = lessons.length - MAX_LESSONS;
  const removeIds = new Set(sorted.slice(0, removeCount).map((l) => l.id));
  return lessons.filter((l) => !removeIds.has(l.id));
}

/** 判断两个项目目录是否相同（归一化，兼容 Windows 反斜杠） */
function sameProject(a, b) {
  if (!a || !b) return false;
  try {
    return path.resolve(a) === path.resolve(b);
  } catch (_) {
    return a === b;
  }
}

/** 把 keywords 归一为小写字符串数组（支持数组或分隔字符串） */
function normalizeKeywords(keywords) {
  if (!keywords) return [];
  const arr = Array.isArray(keywords) ? keywords : String(keywords).split(/[\s,，]+/);
  return arr.map((k) => String(k).trim().toLowerCase()).filter(Boolean);
}

/** 计算 tags 与 keywords 的匹配度（命中多少个 tag） */
function matchScore(tags, kws) {
  if (!Array.isArray(tags) || kws.length === 0) return 0;
  let score = 0;
  for (const tag of tags) {
    const t = String(tag).toLowerCase();
    if (!t) continue;
    for (const kw of kws) {
      if (t === kw || t.includes(kw) || kw.includes(t)) {
        score++;
        break;
      }
    }
  }
  return score;
}

// ========== 对外接口 ==========

/**
 * 记录一条教训
 * @param {object} opts { lesson, context, tags, scope, projectDir }
 *   - lesson 必填：一句话教训
 *   - scope 可选：'global' 或项目目录；缺省时 scope = projectDir || 'global'
 * @returns {{ success: boolean, id?: string, error?: string }}
 */
function recordLesson(opts) {
  const { lesson, context, tags, scope, projectDir } = opts || {};
  if (!lesson || !String(lesson).trim()) {
    return { success: false, error: 'lesson 不能为空' };
  }
  const db = readLessons();
  const sc = scope ? String(scope) : (projectDir ? String(projectDir) : 'global');
  const rec = {
    id: genId(),
    lesson: String(lesson).trim(),
    context: context ? String(context) : '',
    tags: normalizeTags(tags),
    scope: sc,
    projectDir: sc === 'global' ? '' : String(projectDir || sc),
    createdAt: Date.now(),
    hits: 0,
  };
  db.lessons.push(rec);
  db.lessons = evict(db.lessons);
  if (!writeLessons(db)) return { success: false, error: '写入失败' };
  return { success: true, id: rec.id };
}

/** 列出全部教训 */
function listLessons() {
  return readLessons().lessons;
}

/** 删除一条教训 */
function deleteLesson(id) {
  if (!id) return { success: false, error: 'id 不能为空' };
  const db = readLessons();
  const idx = db.lessons.findIndex((l) => l.id === id);
  if (idx === -1) return { success: false, error: '教训不存在: ' + id };
  db.lessons.splice(idx, 1);
  if (!writeLessons(db)) return { success: false, error: '写入失败' };
  return { success: true };
}

/**
 * 筛选匹配教训
 * - scope === projectDir 的教训：全部纳入
 * - scope === 'global' 的教训：按 tags 与 keywords 匹配度排序，取前 limit 条
 * @param {string} projectDir 当前项目目录
 * @param {string[]|string} keywords 关键词
 * @param {number} [limit=5] global 匹配条数上限
 * @returns {Array<{id, lesson, context, tags, hits}>}
 */
function matchLessons(projectDir, keywords, limit = 5) {
  const lim = Number.isInteger(limit) && limit > 0 ? limit : 5;
  const kws = normalizeKeywords(keywords);
  const all = listLessons();

  // 项目专属：全部纳入
  const projectLessons = all.filter(
    (l) => l.scope && l.scope !== 'global' && sameProject(l.scope, projectDir)
  );

  // 全局：按匹配度排序取 Top N（无匹配则不注入）
  const globalScored = all
    .filter((l) => l.scope === 'global')
    .map((l) => ({ l, score: matchScore(l.tags, kws) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => (b.score - a.score) || ((b.l.hits || 0) - (a.l.hits || 0)) || ((b.l.createdAt || 0) - (a.l.createdAt || 0)));

  const globalTop = globalScored.slice(0, lim).map((x) => x.l);

  return projectLessons.concat(globalTop).map((l) => ({
    id: l.id,
    lesson: l.lesson,
    context: l.context,
    tags: l.tags,
    hits: l.hits || 0,
  }));
}

/** 命中计数 +1（注入后调用） */
function bumpHits(ids) {
  const arr = Array.isArray(ids) ? ids : (ids ? [ids] : []);
  if (arr.length === 0) return { success: true, updated: 0 };
  const db = readLessons();
  const set = new Set(arr);
  let updated = 0;
  for (const l of db.lessons) {
    if (set.has(l.id)) {
      l.hits = (l.hits || 0) + 1;
      updated++;
    }
  }
  if (updated > 0) writeLessons(db);
  return { success: true, updated };
}

module.exports = {
  getKnowledgeDir,
  getLessonsFile,
  recordLesson,
  listLessons,
  deleteLesson,
  matchLessons,
  bumpHits,
};
