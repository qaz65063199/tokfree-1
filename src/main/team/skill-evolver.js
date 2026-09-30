/**
 * 技能迭代与淘汰（Skill Evolver）—— Agent 自工程化 Level 3 核心
 *
 * 让技能库自我进化：
 *  - 使用数据回写：每次技能被调用，记录成功/失败/耗时
 *  - 定期优化：分析成功率低/耗时长的技能，标记待优化
 *  - 淘汰归档：长期不用、持续低成功率的技能自动归档，防技能库膨胀
 *
 * 存储：userData/knowledge/skill-stats.json
 *   { stats: { [skillName]: { uses, success, fail, totalMs, lastUsedAt, createdAt, archived } } }
 *
 * 纯统计模块：不改变技能本身，只维护使用数据 + 给出优化/淘汰建议。
 * 归档的技能移入 userData/knowledge/skills-archive/（保留可恢复）。
 */
const fs = require('fs');
const path = require('path');
const { getBaseDir } = require('../../core/agent-runtime/paths');

// ========== 配置 ==========
const CONFIG = {
  // 淘汰阈值
  archiveAfterDaysUnused: 30,   // 超过 N 天未用且成功率低 → 归档
  lowSuccessRate: 0.5,          // 成功率低于此值视为"低效"
  minUsesForEval: 3,            // 至少用过 N 次才评估淘汰（避免误杀新技能）
  // 优化建议阈值
  optimizeSuccessRate: 0.7,     // 成功率低于此值 → 建议优化
  optimizeAvgMs: 30000,         // 平均耗时超过此值 → 建议优化
};

// ========== 路径 ==========
function getKnowledgeDir() {
  const dir = path.join(getBaseDir(), 'knowledge');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function getStatsFile() {
  return path.join(getKnowledgeDir(), 'skill-stats.json');
}
function getArchiveDir() {
  const dir = path.join(getKnowledgeDir(), 'skills-archive');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function backupCorruptFile(file, reason) {
  try {
    if (!fs.existsSync(file)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(file, file + '.corrupt-' + stamp);
    console.error('[SkillEvolver] 文件损坏已备份(' + reason + '):', file);
  } catch (e) {}
}

// ========== 读写 ==========
function readStats() {
  const f = getStatsFile();
  if (!fs.existsSync(f)) return { stats: {} };
  try {
    const obj = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if (obj && obj.stats && typeof obj.stats === 'object') return obj;
    backupCorruptFile(f, '结构非法');
  } catch (err) {
    console.error('[SkillEvolver] 读取统计失败:', err.message);
    backupCorruptFile(f, 'JSON 解析失败');
  }
  return { stats: {} };
}

function writeStats(obj) {
  try {
    fs.writeFileSync(getStatsFile(), JSON.stringify(obj, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[SkillEvolver] 写入统计失败:', err.message);
    return false;
  }
}

function emptyStat() {
  return { uses: 0, success: 0, fail: 0, totalMs: 0, lastUsedAt: 0, createdAt: Date.now(), archived: false };
}

// ========== 使用回写 ==========

/**
 * 记录一次技能使用
 * @param {string} name 技能名
 * @param {{success?:boolean, durationMs?:number}} [opts]
 */
function recordUsage(name, opts) {
  if (!name || typeof name !== 'string') return { success: false, error: '技能名非法' };
  const o = opts || {};
  const db = readStats();
  const s = db.stats[name] || emptyStat();
  s.uses = (s.uses || 0) + 1;
  if (o.success === false) s.fail = (s.fail || 0) + 1;
  else s.success = (s.success || 0) + 1;
  if (typeof o.durationMs === 'number' && o.durationMs > 0) s.totalMs = (s.totalMs || 0) + o.durationMs;
  s.lastUsedAt = Date.now();
  db.stats[name] = s;
  if (!writeStats(db)) return { success: false, error: '写入失败' };
  return { success: true, stat: s };
}

/** 取某技能统计 */
function getStat(name) {
  if (!name) return null;
  const db = readStats();
  return db.stats[name] || null;
}

/** 列出所有技能统计 */
function listStats() {
  const db = readStats();
  return Object.keys(db.stats).map(function (name) {
    return Object.assign({ name: name }, db.stats[name]);
  });
}

/** 成功率（0-1；无使用返回 null） */
function successRate(stat) {
  if (!stat) return null;
  const total = (stat.success || 0) + (stat.fail || 0);
  if (total === 0) return null;
  return (stat.success || 0) / total;
}

/** 平均耗时（ms；无使用返回 null） */
function avgDuration(stat) {
  if (!stat || !stat.uses) return null;
  return Math.round((stat.totalMs || 0) / stat.uses);
}

// ========== 分析 ==========

/**
 * 分析所有技能，返回优化建议 + 淘汰候选
 * @returns {{ needOptimize: Array, archiveCandidates: Array, healthy: Array, summary: object }}
 */
function analyze() {
  const all = listStats();
  const now = Date.now();
  const needOptimize = [];
  const archiveCandidates = [];
  const healthy = [];

  for (const s of all) {
    if (s.archived) continue;
    const rate = successRate(s);
    const avg = avgDuration(s);
    const daysUnused = s.lastUsedAt ? Math.floor((now - s.lastUsedAt) / 86400000) : null;

    // 淘汰候选：用过足够多次 + 成功率低 + 长期不用
    if (
      s.uses >= CONFIG.minUsesForEval &&
      rate !== null && rate < CONFIG.lowSuccessRate &&
      daysUnused !== null && daysUnused >= CONFIG.archiveAfterDaysUnused
    ) {
      archiveCandidates.push({ name: s.name, rate: rate, avgMs: avg, daysUnused: daysUnused, uses: s.uses, reason: '长期不用且成功率低' });
      continue;
    }

    // 优化建议：成功率偏低 或 平均耗时过长
    if (
      (rate !== null && rate < CONFIG.optimizeSuccessRate && s.uses >= CONFIG.minUsesForEval) ||
      (avg !== null && avg > CONFIG.optimizeAvgMs)
    ) {
      const reasons = [];
      if (rate !== null && rate < CONFIG.optimizeSuccessRate) reasons.push('成功率低(' + Math.round(rate * 100) + '%)');
      if (avg !== null && avg > CONFIG.optimizeAvgMs) reasons.push('耗时长(平均' + avg + 'ms)');
      needOptimize.push({ name: s.name, rate: rate, avgMs: avg, uses: s.uses, reason: reasons.join('、') });
      continue;
    }

    healthy.push({ name: s.name, rate: rate, avgMs: avg, uses: s.uses });
  }

  return {
    needOptimize: needOptimize,
    archiveCandidates: archiveCandidates,
    healthy: healthy,
    summary: {
      total: all.filter(function (s) { return !s.archived; }).length,
      needOptimize: needOptimize.length,
      archiveCandidates: archiveCandidates.length,
      healthy: healthy.length,
    },
  };
}

/** 列出需要优化的技能（供技能优化器消费） */
function listNeedingOptimize() {
  return analyze().needOptimize;
}

/** 列出淘汰候选 */
function listArchiveCandidates() {
  return analyze().archiveCandidates;
}

// ========== 淘汰归档 ==========

/**
 * 归档一个技能（从注册表移除 + 正文移入 archive，可恢复）
 * @param {string} name
 * @param {string} reason
 */
function archiveSkill(name, reason) {
  if (!name || typeof name !== 'string') return { success: false, error: '技能名非法' };
  let knowledge;
  try { knowledge = require('../knowledge'); } catch (e) { return { success: false, error: 'knowledge 模块不可用' }; }

  const content = knowledge.readSkill(name);
  if (content === null) return { success: false, error: '技能不存在: ' + name };

  try {
    // 正文移入 archive
    const archiveFile = path.join(getArchiveDir(), name + '.md');
    fs.writeFileSync(archiveFile, content, 'utf-8');
    // 记录归档原因
    const metaFile = path.join(getArchiveDir(), name + '.meta.json');
    fs.writeFileSync(metaFile, JSON.stringify({ name: name, reason: reason || '', archivedAt: new Date().toISOString() }, null, 2), 'utf-8');
    // 从注册表移除（deleteSkill 会删正文文件，先备份已完成）
    knowledge.deleteSkill(name);
    // 标记统计为已归档
    const db = readStats();
    if (db.stats[name]) { db.stats[name].archived = true; db.stats[name].archivedAt = Date.now(); }
    writeStats(db);
    return { success: true, archivedTo: archiveFile };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** 从归档恢复技能 */
function restoreSkill(name) {
  if (!name) return { success: false, error: '技能名非法' };
  const archiveFile = path.join(getArchiveDir(), name + '.md');
  if (!fs.existsSync(archiveFile)) return { success: false, error: '归档不存在: ' + name };
  let knowledge;
  try { knowledge = require('../knowledge'); } catch (e) { return { success: false, error: 'knowledge 模块不可用' }; }
  try {
    const content = fs.readFileSync(archiveFile, 'utf-8');
    let meta = {};
    const metaFile = path.join(getArchiveDir(), name + '.meta.json');
    if (fs.existsSync(metaFile)) {
      try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')); } catch (_) {}
    }
    const res = knowledge.createSkill(name, content, { description: (meta && meta.description) || '', tags: (meta && meta.tags) || [] });
    if (!res.success) return res;
    const db = readStats();
    if (db.stats[name]) { db.stats[name].archived = false; delete db.stats[name].archivedAt; }
    writeStats(db);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** 批量执行淘汰（供每日优化器调用） */
function runArchivePass() {
  const cands = listArchiveCandidates();
  const results = [];
  for (const c of cands) {
    results.push({ name: c.name, result: archiveSkill(c.name, c.reason) });
  }
  return { archived: results.filter(function (x) { return x.result && x.result.success; }).length, details: results };
}

/** 清空所有统计（调试用） */
function clearStats() {
  return writeStats({ stats: {} });
}

module.exports = {
  recordUsage,
  getStat,
  listStats,
  successRate,
  avgDuration,
  analyze,
  listNeedingOptimize,
  listArchiveCandidates,
  archiveSkill,
  restoreSkill,
  runArchivePass,
  clearStats,
  CONFIG,
};
