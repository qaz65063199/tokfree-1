/**
 * 全局知识库管理（跨项目共享）
 *
 * 解决痛点：经验/技能/偏好现在沉在各项目 .tokfreeCode/ 里，无法跨项目复用。
 * 本模块提供"全局层"，由 project-context 在初始化时按需注入提示词。
 *
 * 目录结构（userData/knowledge/）：
 *   preferences.md      全局偏好（所有项目无条件注入）
 *   skills.json         技能注册表 { skills: [{name, description, tags, createdAt}] }
 *   skills/<name>.md    单个技能正文（Markdown）
 *
 * 项目级：
 *   <projectDir>/.tokfreeCode/enabled-skills.json  { enabled: [name, ...] }
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULT_PREFERENCES = [
  '# 全局偏好',
  '',
  '> 记录你的通用偏好（写作风格、沟通习惯、工作方式），所有项目自动生效。',
  '> 可直接编辑本文件，或让 AI 用 preference_append 追加。',
  '',
  '## 沟通风格',
  '- （待补充）',
  '',
  '## 工作方式',
  '- （待补充）',
  '',
  '## 写作偏好',
  '- （待补充）',
  '',
].join('\n');

// ========== 路径 ==========

function getKnowledgeDir() {
  const dir = path.join(app.getPath('userData'), 'knowledge');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getSkillsDir() {
  const dir = path.join(getKnowledgeDir(), 'skills');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getRegistryFile() {
  return path.join(getKnowledgeDir(), 'skills.json');
}

function getPreferencesFile() {
  return path.join(getKnowledgeDir(), 'preferences.md');
}

// ========== 全局偏好 ==========

/** 读取全局偏好（不存在则创建默认模板并返回） */
function readPreferences() {
  try {
    const f = getPreferencesFile();
    if (!fs.existsSync(f)) {
      fs.writeFileSync(f, DEFAULT_PREFERENCES, "utf-8");
      return DEFAULT_PREFERENCES;
    }
    return fs.readFileSync(f, "utf-8");
  } catch (err) {
    console.error('[Knowledge] 读取偏好失败:', err.message);
    return '';
  }
}

/** 覆盖写入全局偏好 */
function writePreferences(content) {
  try {
    fs.writeFileSync(getPreferencesFile(), String(content || ''), 'utf-8');
    return true;
  } catch (err) {
    console.error('[Knowledge] 写入偏好失败:', err.message);
    return false;
  }
}

/** 追加一条偏好（自动加 - 前缀） */
function appendPreference(text) {
  try {
    const cur = readPreferences();
    const line = '- ' + String(text || '').trim();
    const next = cur.replace(/\s*$/, '') + '\n' + line + '\n';
    return writePreferences(next);
  } catch (err) {
    console.error('[Knowledge] 追加偏好失败:', err.message);
    return false;
  }
}

// ========== 技能注册表 ==========

/**
 * 技能名校验（防目录穿越）：只允许字母/数字/下划线/连字符。
 * createSkill 用于拒绝非法名；read/update/delete 同样需要，避免
 * name = "../../etc/passwd" 之类穿越出 skills 目录。
 */
function isValidSkillName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_-]+$/.test(name);
}

/** 把损坏文件改名备份，避免静默覆盖造成"数据丢失"错觉 */
function backupCorruptFile(file, reason) {
  try {
    if (!fs.existsSync(file)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(file, file + '.corrupt-' + stamp);
    console.error('[Knowledge] 文件损坏已备份(' + reason + '):', file);
  } catch (e) {
    console.error('[Knowledge] 备份损坏文件失败:', e.message);
  }
}

function readRegistry() {
  const f = getRegistryFile();
  if (!fs.existsSync(f)) return { skills: [] };
  try {
    const obj = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if (obj && Array.isArray(obj.skills)) return obj;
    backupCorruptFile(f, '结构非法');
  } catch (err) {
    console.error('[Knowledge] 读取技能注册表失败:', err.message);
    backupCorruptFile(f, 'JSON 解析失败');
  }
  return { skills: [] };
}

function writeRegistry(obj) {
  try {
    fs.writeFileSync(getRegistryFile(), JSON.stringify(obj, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[Knowledge] 写入技能注册表失败:', err.message);
    return false;
  }
}

/** 列出所有技能元数据 */
function listSkills() {
  return readRegistry().skills;
}

/** 读取某个技能正文（不存在返回 null；非法名返回 null） */
function readSkill(name) {
  if (!isValidSkillName(name)) return null;
  try {
    const f = path.join(getSkillsDir(), name + '.md');
    if (!fs.existsSync(f)) return null;
    return fs.readFileSync(f, 'utf-8');
  } catch (err) {
    console.error('[Knowledge] 读取技能失败:', err.message);
    return null;
  }
}

/**
 * 创建技能
 * @param {string} name 唯一名（建议 kebab-case）
 * @param {string} content 正文（Markdown）
 * @param {object} [meta] { description, tags }
 */
function createSkill(name, content, meta) {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return { success: false, error: '技能名非法（只允许字母/数字/下划线/连字符）' };
  }
  const reg = readRegistry();
  if (reg.skills.some(s => s.name === name)) {
    return { success: false, error: '技能已存在: ' + name };
  }
  try {
    fs.writeFileSync(path.join(getSkillsDir(), name + '.md'), String(content || ''), 'utf-8');
    reg.skills.push({
      name,
      description: (meta && meta.description) || '',
      tags: (meta && meta.tags) || [],
      createdAt: new Date().toISOString(),
    });
    writeRegistry(reg);
    return { success: true, name };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** 更新技能正文（也支持改描述/标签） */
function updateSkill(name, content, meta) {
  if (!isValidSkillName(name)) {
    return { success: false, error: '技能名非法（只允许字母/数字/下划线/连字符）' };
  }
  const reg = readRegistry();
  const item = reg.skills.find(s => s.name === name);
  if (!item) return { success: false, error: '技能不存在: ' + name };
  try {
    if (typeof content === 'string') {
      // 版本化：写新正文前，把旧正文快照存入 versions/ 并更新 active.json
      const cur = readSkill(name);
      if (cur !== null) recordVersionSnapshot(name, cur);
      fs.writeFileSync(path.join(getSkillsDir(), name + '.md'), content, 'utf-8');
    }
    if (meta) {
      if (typeof meta.description === 'string') item.description = meta.description;
      if (Array.isArray(meta.tags)) item.tags = meta.tags;
    }
    writeRegistry(reg);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** 删除技能 */
function deleteSkill(name) {
  if (!isValidSkillName(name)) {
    return { success: false, error: '技能名非法（只允许字母/数字/下划线/连字符）' };
  }
  const reg = readRegistry();
  const idx = reg.skills.findIndex(s => s.name === name);
  if (idx === -1) return { success: false, error: '技能不存在: ' + name };
  try {
    const f = path.join(getSkillsDir(), name + '.md');
    if (fs.existsSync(f)) fs.unlinkSync(f);
    reg.skills.splice(idx, 1);
    writeRegistry(reg);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ========== 技能版本化（快照 + 回退） ==========
//
// 借鉴 Mastra 的 activeVersionId + 快照模型，纯本地实现：
//   skills/<name>/versions/<version>.md  ← 每次 update 前的旧正文快照
//   skills/<name>/active.json            ← { activeVersionId, history: [version...] }
//   skills/<name>.md                     ← 仍是当前 active 版本正文（向后兼容）
//
// 说明：版本 id 用毫秒时间戳字符串（同一毫秒内多次更新自动递增避免冲突）。
// 保留最近 MAX_SKILL_VERSIONS 个快照，超出清理最旧。

const MAX_SKILL_VERSIONS = 20;

/** 技能版本目录：skills/<name>/versions */
function getSkillVersionDir(name) {
  return path.join(getSkillsDir(), name, 'versions');
}

/** active.json 路径：skills/<name>/active.json */
function getSkillActiveFile(name) {
  return path.join(getSkillsDir(), name, 'active.json');
}

/** 生成下一个版本 id（毫秒时间戳，冲突则递增） */
function nextVersionId(dir) {
  let id = String(Date.now());
  let guard = 0;
  while (fs.existsSync(path.join(dir, id + '.md')) && guard < 100000) {
    id = String(Number(id) + 1);
    guard++;
  }
  return id;
}

/** 读取 active.json（损坏/缺失容错，返回 { activeVersionId, history }） */
function readActive(name) {
  const def = { activeVersionId: null, history: [] };
  if (!isValidSkillName(name)) return def;
  const f = getSkillActiveFile(name);
  if (!fs.existsSync(f)) return def;
  try {
    const obj = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if (obj && typeof obj === 'object') {
      return {
        activeVersionId: obj.activeVersionId || null,
        history: Array.isArray(obj.history) ? obj.history.filter(function (h) { return typeof h === 'string'; }) : [],
      };
    }
    backupCorruptFile(f, '结构非法');
  } catch (err) {
    console.error('[Knowledge] 读取 active.json 失败:', err.message);
    backupCorruptFile(f, 'JSON 解析失败');
  }
  return def;
}

/** 写入 active.json（失败返回 false，不抛出） */
function writeActive(name, obj) {
  try {
    const dir = path.join(getSkillsDir(), name);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getSkillActiveFile(name), JSON.stringify(obj, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[Knowledge] 写入 active.json 失败:', err.message);
    return false;
  }
}

/**
 * 把一段正文快照存入 versions/，并把该版本追加到 active.json 的 history。
 * 同时在返回版本 id 前，把 activeVersionId 更新为刚快照的版本（旧正文即"当前生效版本"）。
 * @returns {string|null} 版本 id（失败返回 null）
 */
function recordVersionSnapshot(name, content) {
  if (!isValidSkillName(name)) return null;
  try {
    const dir = getSkillVersionDir(name);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const vid = nextVersionId(dir);
    fs.writeFileSync(path.join(dir, vid + '.md'), String(content == null ? '' : content), 'utf-8');
    const act = readActive(name);
    act.history.push(vid);
    act.activeVersionId = vid;
    // 保留最近 MAX_SKILL_VERSIONS 个，清理最旧
    const keep = act.history.slice(-MAX_SKILL_VERSIONS);
    const removed = act.history.slice(0, Math.max(0, act.history.length - MAX_SKILL_VERSIONS));
    act.history = keep;
    for (const old of removed) {
      try { fs.unlinkSync(path.join(dir, old + '.md')); } catch (_) { /* 尽力而为 */ }
    }
    writeActive(name, act);
    return vid;
  } catch (err) {
    console.error('[Knowledge] 写入版本快照失败:', err.message);
    return null;
  }
}

/** 快照正文摘要：取首行非空文本，截断至 80 字符 */
function summarizeVersion(content) {
  try {
    const line = String(content || '').split('\n').find(function (l) { return l.trim(); }) || '';
    return line.trim().slice(0, 80);
  } catch (_) { return ''; }
}

/**
 * 列出某技能的所有版本快照（按版本 id 升序 = 时间先后）
 * @returns {Array<{ version: string, summary: string, active: boolean, mtime: number }>}
 */
function listSkillVersions(name) {
  if (!isValidSkillName(name)) return [];
  try {
    const dir = getSkillVersionDir(name);
    if (!fs.existsSync(dir)) return [];
    const act = readActive(name);
    const files = fs.readdirSync(dir).filter(function (f) { return f.endsWith('.md'); });
    const out = [];
    for (const f of files) {
      const version = f.slice(0, -3);
      let body = '';
      try { body = fs.readFileSync(path.join(dir, f), 'utf-8'); } catch (_) { body = ''; }
      let mtime = 0;
      try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch (_) { mtime = 0; }
      out.push({ version: version, summary: summarizeVersion(body), active: act.activeVersionId === version, mtime: mtime });
    }
    out.sort(function (a, b) { return a.version < b.version ? -1 : (a.version > b.version ? 1 : 0); });
    return out;
  } catch (err) {
    console.error('[Knowledge] 列出技能版本失败:', err.message);
    return [];
  }
}

/**
 * 回退到指定版本：把该快照正文拷回 skills/<name>.md，并更新 active.json。
 * @param {string} name 技能名
 * @param {string} version 版本 id
 * @returns {{success:boolean, error?:string, version?:string}}
 */
function restoreSkillVersion(name, version) {
  if (!isValidSkillName(name)) return { success: false, error: '技能名非法（只允许字母/数字/下划线/连字符）' };
  if (!version || typeof version !== 'string') return { success: false, error: '缺少版本号 version' };
  // 版本号仅允许数字（含冲突递增后缀的纯数字），防目录穿越
  if (!/^[0-9]+$/.test(version)) return { success: false, error: '版本号非法' };
  try {
    const f = path.join(getSkillVersionDir(name), version + '.md');
    if (!fs.existsSync(f)) return { success: false, error: '版本不存在: ' + version };
    const content = fs.readFileSync(f, 'utf-8');
    fs.writeFileSync(path.join(getSkillsDir(), name + '.md'), content, 'utf-8');
    const act = readActive(name);
    act.activeVersionId = version;
    writeActive(name, act);
    return { success: true, version: version };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ========== 项目级启用状态 ==========

function getEnabledFile(projectDir) {
  return path.join(projectDir, '.tokfreeCode', 'enabled-skills.json');
}

// ========== 全局启用状态（跨项目，所有窗口共用） ==========

function getGlobalEnabledFile() {
  return path.join(getKnowledgeDir(), 'global-enabled.json');
}

/** 读取全局启用的技能列表 */
function getGlobalEnabledSkills() {
  const f = getGlobalEnabledFile();
  if (!fs.existsSync(f)) return [];
  try {
    const obj = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if (obj && Array.isArray(obj.enabled)) return obj.enabled;
    backupCorruptFile(f, '结构非法');
  } catch (err) {
    console.error('[Knowledge] 读取全局启用技能失败:', err.message);
    backupCorruptFile(f, 'JSON 解析失败');
  }
  return [];
}

/** 全局启用某技能 */
function enableSkillGlobal(name) {
  const reg = readRegistry();
  if (!reg.skills.some(s => s.name === name)) {
    return { success: false, error: '技能不存在: ' + name };
  }
  const enabled = getGlobalEnabledSkills();
  if (enabled.indexOf(name) !== -1) return { success: true, already: true };
  enabled.push(name);
  try {
    fs.writeFileSync(getGlobalEnabledFile(), JSON.stringify({ enabled }, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** 全局禁用某技能 */
function disableSkillGlobal(name) {
  const enabled = getGlobalEnabledSkills();
  const idx = enabled.indexOf(name);
  if (idx === -1) return { success: true, already: true };
  enabled.splice(idx, 1);
  try {
    fs.writeFileSync(getGlobalEnabledFile(), JSON.stringify({ enabled }, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** 读取某项目启用的技能列表 */
function getEnabledSkills(projectDir) {
  const f = getEnabledFile(projectDir);
  if (!fs.existsSync(f)) return [];
  try {
    const obj = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if (obj && Array.isArray(obj.enabled)) return obj.enabled;
    backupCorruptFile(f, '结构非法');
  } catch (err) {
    console.error('[Knowledge] 读取启用技能失败:', err.message);
    backupCorruptFile(f, 'JSON 解析失败');
  }
  return [];
}

/** 项目启用某技能 */
function enableSkill(projectDir, name) {
  const reg = readRegistry();
  if (!reg.skills.some(s => s.name === name)) {
    return { success: false, error: '技能不存在: ' + name };
  }
  const enabled = getEnabledSkills(projectDir);
  if (enabled.indexOf(name) !== -1) return { success: true, already: true };
  enabled.push(name);
  try {
    const dir = path.join(projectDir, '.tokfreeCode');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getEnabledFile(projectDir), JSON.stringify({ enabled }, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** 项目禁用某技能 */
function disableSkill(projectDir, name) {
  const enabled = getEnabledSkills(projectDir);
  const idx = enabled.indexOf(name);
  if (idx === -1) return { success: true, already: true };
  enabled.splice(idx, 1);
  try {
    fs.writeFileSync(getEnabledFile(projectDir), JSON.stringify({ enabled }, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ========== 注入用 ==========

/**
 * 技能语义/关键词检索 —— 按任务描述匹配最相关的技能
 *
 * 设计：无需向量库，用"关键词 + 标签 + 名称"的加权匹配（轻量、零依赖、够用）。
 * 匹配来源：技能 name / description / tags 与 query 分词的交集。
 *
 * @param {string} query 任务描述（如用户的请求）
 * @param {object} [opts]
 *   - pool：候选技能元数据（默认 listSkills()）
 *   - limit：返回条数上限（默认 5）
 *   - minScore：最低分（默认 1，即至少命中一个词）
 * @returns {Array<{name, description, tags, score, matched}>}
 */
function searchSkills(query, opts) {
  const o = opts || {};
  const pool = Array.isArray(o.pool) ? o.pool : listSkills();
  const limit = typeof o.limit === 'number' ? o.limit : 5;
  const minScore = typeof o.minScore === 'number' ? o.minScore : 1;
  if (!query || typeof query !== 'string' || pool.length === 0) return [];

  // 分词：英文按非字母数字切；中文按 2-gram 切（无分词器时的通用近似）
  const words = new Set();
  const lower = query.toLowerCase();
  // 英文/数字词
  const enWords = lower.split(/[^a-z0-9]+/).filter(function (w) { return w.length >= 2; });
  enWords.forEach(function (w) { words.add(w); });
  // 中文 2-gram
  const cn = lower.match(/[\u4e00-\u9fa5]+/g) || [];
  cn.forEach(function (seg) {
    for (let i = 0; i < seg.length - 1; i++) words.add(seg.slice(i, i + 2));
    if (seg.length === 1) words.add(seg);
  });
  if (words.size === 0) return [];

  const scored = [];
  for (const s of pool) {
    const name = String(s.name || '').toLowerCase();
    const desc = String(s.description || '').toLowerCase();
    const tags = (Array.isArray(s.tags) ? s.tags : []).map(function (t) { return String(t).toLowerCase(); });
    const hay = name + ' ' + desc + ' ' + tags.join(' ');
    let score = 0;
    const matched = [];
    for (const w of words) {
      if (!w) continue;
      // 名称命中权重高（3），标签次之（2），描述（1）
      if (name.indexOf(w) !== -1) { score += 3; matched.push(w); }
      else if (tags.some(function (t) { return t.indexOf(w) !== -1; })) { score += 2; matched.push(w); }
      else if (desc.indexOf(w) !== -1) { score += 1; matched.push(w); }
    }
    if (score >= minScore) {
      scored.push({ name: s.name, description: s.description, tags: s.tags, score: score, matched: Array.from(new Set(matched)) });
    }
  }
  scored.sort(function (a, b) { return b.score - a.score; });
  return scored.slice(0, limit);
}

// ========== 技能安全扫描（借鉴 DeerFlow security_scanner） ==========

/**
 * 明显危险命令黑名单（只扫"一看就危险"的，不追求完备，避免误伤）。
 * 每项：{ pattern: 正则（不区分大小写）, label: 展示用标识 }
 */
const DANGEROUS_SKILL_PATTERNS = [
  { pattern: /rm\s+-rf\s+\//i, label: 'rm -rf /' },
  { pattern: /curl[^\n|]*\|\s*sh\b/i, label: 'curl | sh' },
  { pattern: /curl[^\n|]*\|\s*bash\b/i, label: 'curl | bash' },
  { pattern: /wget[^\n|]*\|\s*sh\b/i, label: 'wget | sh' },
  { pattern: /wget[^\n|]*\|\s*bash\b/i, label: 'wget | bash' },
  { pattern: /\bmkfs\b/i, label: 'mkfs' },
  { pattern: /\bdd\s+if=/i, label: 'dd if=' },
  { pattern: /:\s*\(\s*\)\s*\{/i, label: 'fork bomb' },
  { pattern: /\.\s*\(\s*\)\s*\{/i, label: 'fork bomb' },
  { pattern: />\s*\/dev\/sd/i, label: '> /dev/sd' },
  { pattern: /chmod\s+777\s+\//i, label: 'chmod 777 /' },
  { pattern: /\bshutdown\b/i, label: 'shutdown' },
  { pattern: /format\s+c:/i, label: 'format c:' },
];

/**
 * 扫描技能正文是否包含明显危险命令。
 * 保守设计：出错一律视为安全（不阻断正常流程）。
 * @param {string} content 技能正文
 * @returns {{ safe: boolean, hits: Array<{ pattern: string, snippet: string }> }}
 */
function scanSkillContent(content) {
  try {
    const text = String(content == null ? '' : content);
    const hits = [];
    for (const item of DANGEROUS_SKILL_PATTERNS) {
      const m = item.pattern.exec(text);
      if (m) {
        hits.push({ pattern: item.label, snippet: text.slice(m.index, m.index + 80) });
      }
    }
    return { safe: hits.length === 0, hits: hits };
  } catch (err) {
    return { safe: true, hits: [] };
  }
}

/**
 * 组装"知识库"章节（供 project-context 注入提示词）
 *
 * 渐进式披露（参考 agentskills.io）：
 *  - 技能"目录"（名称+描述）：总是注入，轻量，让 AI 知道有哪些技能；
 *  - 技能"正文"：只注入与当前任务(query)相关的（省上下文，避免撑爆）。
 *
 * @param {string} projectDir 当前项目目录（可为空，则只注入全局偏好）
 * @param {string} [query] 当前任务描述（用于检索相关技能正文；缺省则注入全部启用技能正文）
 * @returns {string} markdown 文本（无内容返回空串）
 */
function buildKnowledgeSection(projectDir, query) {
  const parts = [];

  // 1. 全局偏好（无条件）
  const prefs = readPreferences();
  if (prefs && prefs.trim()) {
    if (prefs.indexOf('（待补充）') === -1) {
      parts.push('## 用户全局偏好（跨项目）\n\n' + prefs.trim());
    } else {
      parts.push('## 用户全局偏好（跨项目）\n\n（用户尚未填写偏好；如你观察到稳定的偏好，可主动提议用 preference_append 记录）');
    }
  }

  // 2. 启用的技能（渐进式披露）：项目级启用 ∪ 全局级启用（去重）
  if (projectDir) {
    const projEnabled = getEnabledSkills(projectDir);
    const globalEnabled = getGlobalEnabledSkills();
    const seen = {};
    const enabledNames = [];
    projEnabled.concat(globalEnabled).forEach(function (n) {
      if (n && !seen[n]) { seen[n] = 1; enabledNames.push(n); }
    });
    if (enabledNames.length > 0) {
      const allMeta = listSkills();
      const byName = {};
      allMeta.forEach(function (s) { byName[s.name] = s; });
      const enabledMeta = enabledNames.map(function (n) { return byName[n] || { name: n, description: '' }; });

      // 2.1 目录（名称+描述）：总是注入（轻量）
      const catalogLines = enabledMeta.map(function (s) {
        return '- **' + s.name + '**：' + (s.description || '(无描述)');
      });
      parts.push('## 本项目已启用的技能（目录）\n\n' + catalogLines.join('\n') +
        '\n\n> 需要某个技能的详细步骤时，用 skill_read(name) 读取正文。');

      // 2.2 正文：只注入与当前任务相关的（有 query 时检索，否则全注入）
      let injectNames;
      if (query && typeof query === 'string' && query.trim()) {
        const hits = searchSkills(query, { pool: enabledMeta, limit: 5, minScore: 1 });
        injectNames = hits.map(function (h) { return h.name; });
        // 若检索无命中，退化为注入全部（确保不漏）
        if (injectNames.length === 0) injectNames = enabledNames.slice(0, 3);
      } else {
        injectNames = enabledNames;
      }

      const skillParts = [];
      for (const name of injectNames) {
        const body = readSkill(name);
        if (body) {
          // 安全扫描：命中危险命令时在正文前追加警告标注（不剔除内容，避免行为突变）
          let prefix = '';
          try {
            const scan = scanSkillContent(body);
            if (scan && scan.safe === false) {
              prefix = '⚠️ 此技能包含可疑命令，请谨慎执行\n\n';
            }
          } catch (_) {}
          skillParts.push('### 技能：' + name + '\n\n' + prefix + body.trim());
        }
      }
      if (skillParts.length > 0) {
        const isFiltered = !!(query && query.trim()) && injectNames.length < enabledNames.length;
        parts.push('## 相关技能（正文）' +
          (isFiltered ? '（按当前任务检索，共 ' + injectNames.length + '/' + enabledNames.length + ' 条）' : '') +
          '\n\n' + skillParts.join('\n\n'));
      }
    }
  }

  // 2.5 元技能当前方法（Level 3：让 AI 按最新"复盘/生成/优化"方法工作）
  try {
    const meta = require('./team/meta-evolve');
    if (meta && typeof meta.getMetaVersion === 'function') {
      const mv = meta.getMetaVersion();
      if (mv && mv.version > 1 && mv.methods) {
        parts.push([
          '## 自工程化「方法」当前版本 v' + mv.version + '（元技能进化产物）',
          '',
          '> 这些是"如何复盘/生成/优化"的方法本身，会随系统自进化而更新。请按最新方法工作：',
          '- **复盘方法**：' + (mv.methods.retrospect || ''),
          '- **生成方法**：' + (mv.methods.forge || ''),
          '- **优化方法**：' + (mv.methods.optimize || ''),
        ].join('\n'));
      }
    }
  } catch (_) {}

  // 3. 技能库使用说明（含技能结构示例，确保任何窗口的 AI 都知道怎么写技能）
  parts.push([
    '## 技能库（跨项目复用工作方法）',
    '',
    '本应用有**跨项目**技能库。**任何项目的 AI 都可以查看、创建、启用技能**——即使你当前不在最初创建该技能的项目里。',
    '',
    '### 什么是技能',
    '一个技能 = 一份 Markdown 文档，描述"某一类工作该怎么做"。',
    '技能是**方法论**（可复用）；事件/决策记录请用 MemPalace，不要混。',
    '',
    '**结构示例**：',
    '',
    '  技能名：party-report',
    '  正文（Markdown）：',
    '    # 党建报告写作',
    '    1. 结构：背景 → 主要做法 → 成效 → 下一步',
    '    2. 语言：正式书面，避免口语',
    '    3. 每个观点配一个具体数据',
    '    4. 结尾呼应主题，不做空泛表态',
    '',
    '### 技能名规范',
    '只允许 字母/数字/下划线/连字符，建议 kebab-case（如 party-report、code-review）。',
    '',
    '### 工具',
    '- skill_list() — 查看全部技能（含 name/description/tags）',
    '- skill_list_enabled() — 查看当前项目启用了哪些技能',
    '- skill_read(name) — 读取某技能全文（不确定写法时，先读一个现成技能参考）',
    '- skill_create(name, content, { description, tags }) — 创建技能',
    '- skill_update(name, content) — 更新技能正文',
    '- skill_delete(name) — 删除技能',
    '- skill_version_list(name) — 列出该技能的历史版本（快照）',
    '- skill_version_restore(name, version) — 回退到指定历史版本',
    '- skill_enable(name) / skill_disable(name) — 在本项目启用/禁用',
    '- preference_append(text) — 追加一条全局偏好（跨项目生效）',
    '',
    '### 主动沉淀（重要）',
    '完成一次任务后，若发现一套"以后可能复用"的工作方法，**主动提议**用户存为技能。',
    '示例：「要不要把这次的党建报告写法存为技能 party-report？以后其他项目也能直接启用。」',
    '',
    '### 与 MemPalace 的分工',
    '- 技能 = 可复用的能力（怎么做）——主动注入提示词，AI 一定看到',
    '- MemPalace = 发生过的事件/决策——按需检索',
    '',
    '## 自工程化（自写/自修复/自迭代技能）',
    '',
    '本应用会**自动记录每次任务执行轨迹**，并支持你（AI）主动复盘、生成、迭代技能——',
    '让系统越用越聪明。这是"技能层演化"（不碰模型权重）。',
    '',
    '### 闭环飞轮',
    '执行任务 → 记录轨迹 → 复盘分析 → 生成/优化技能 → 沙盒验证 → 入库 → 下次优先调用',
    '',
    '### 工具（若可用）',
    '- auto_trace_list(limit) — 看最近执行轨迹',
    '- auto_trace_get(taskId) — 看某轨迹详情',
    '- auto_retrospect(taskId) — 复盘某轨迹（返回分析 + 复盘 Prompt）',
    '- auto_skill_forge(analysis) — 从复盘发现生成技能草稿并验证',
    '- auto_skill_forge_commit(draft) — 验证通过则入库',
    '- auto_skill_stats() — 看技能使用统计（成功率/耗时）',
    '- auto_skill_archive_pass() — 淘汰长期低效技能',
    '',
    '**元技能进化（Level 3）**：',
    '- auto_meta_record(activity, success, usefulScore?) — 记录一次自工程化活动效果',
    '- auto_meta_analyze() — 分析"复盘/生成/优化"方法本身是否有效，给出元改进建议',
    '- auto_meta_version() — 查当前方法版本与历史',
    '- auto_meta_bump(reason, patchMethods?) — 升级方法（改进"如何改进"本身）',
    '',
    '### 何时主动自工程化（重要）',
    '- **完成一个复杂任务后**：auto_trace_list 找到本次轨迹 → auto_retrospect 复盘 → 若有可复用流程，auto_skill_forge 生成技能 → 验证通过则入库。',
    '- **某技能用得不顺时**：auto_skill_stats 看它的成功率，低则考虑优化。',
    '- **定期**（如项目里程碑）：auto_skill_stats + auto_skill_archive_pass 清理低效技能。',
    '',
    '原则：**只有真正可复用的方法论才沉淀为技能**（同一件事做过 2-3 次再沉淀），避免技能库被一次性经验污染。',
    '',
    '## 自驱循环（无人干预持续进化）',
    '',
    '当用户设定一个"需要持续打磨直到达标"的目标时，用**自驱循环**：',
    '系统会在无人工干预下持续推进——执行 → 复盘 → 生成/优化技能 → 再执行，直到达标。',
    '',
    '### 工具',
    '- auto_goal_create(title, successCriteria[], maxRounds?, maxMs?) — **创建目标（人类设一次）**',
    '  - successCriteria 是关键：每条一个**可验证**的条件（如"npm test 全绿""功能X可用"）',
    '- auto_goal_list(status?) — 看所有目标及进度',
    '- auto_goal_status(goalId) — 看某目标详情 + 下一轮该做什么',
    '- auto_goal_round(goalId, criteriaResults, aiScore?, actions?, note?) — **每轮结束时记录**（对照标准填 true/false）',
    '- auto_goal_abort(goalId, reason?) — 中止',
    '',
    '### 何时用自驱循环（重要）',
    '- 用户说"**一直做，直到达标**""**无人干预**""**自己迭代**""**做到完美**" → 建目标',
    '- 用户说"**我要去睡觉了**，你自己搞定" → 建目标 + 循环自己跑',
    '- 复杂/多轮打磨的任务（如"把这个功能做到测试全绿 + 无 lint"）→ 建目标',
    '',
    '### 循环怎么转（你只需做两件事）',
    '1. **建目标**：auto_goal_create，把达标标准写清楚；',
    '2. **每轮结束时记录**：auto_goal_round，对照标准填 true/false。',
    '',
    '系统（驱动器）会自动在合适时机给你注入"下一轮指令"——你不用一直轮询。',
    '收到"第 N 轮"指令时，按指令执行/复盘/生成技能，完成后调 auto_goal_round 记录。',
    '',
    '### 重要边界（防失控）',
    '- 目标有**轮次上限**（默认20）和**时长上限**（默认6小时），到顶会自动停；',
    '- 连续多轮无提升会触发**熔断**（停止并汇报），避免死循环空转；',
    '- 达标（所有标准满足）会**自动停止**。',
    '',
    '### 示例',
    '用户：「帮我实现登录功能，做到单元测试全绿，我要睡觉了」',
    '你：auto_goal_create("实现登录功能", ["登录接口可用", "单元测试全绿", "无类型错误"])',
    '→ 然后每轮：执行 → 记录 → 系统推进 → 复盘/生成技能 → 再执行 → 达标停',
  ].join('\n'));

  return parts.join('\n\n---\n\n');
}

module.exports = {
  getKnowledgeDir,
  getSkillsDir,
  readPreferences,
  writePreferences,
  appendPreference,
  listSkills,
  readSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  getEnabledSkills,
  enableSkill,
  disableSkill,
  getGlobalEnabledSkills,
  enableSkillGlobal,
  disableSkillGlobal,
  buildKnowledgeSection,
  searchSkills,
  scanSkillContent,
  listSkillVersions,
  restoreSkillVersion,
};