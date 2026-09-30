'use strict';

/**
 * 元技能进化（MetaEvolve）—— Agent 自工程化 Level 3 核心
 *
 * 双时间尺度自进化：
 *   - 任务级（快）：trace → retrospect → skill-forge（Level 1/2，已实现）
 *   - 元级（慢）：观察「复盘/生成/验证」这些方法本身是否有效，并改进它们
 *
 * 本模块只做元层：
 *   1. 收集自工程化活动的结果数据（recordMetaOutcome）
 *   2. 分析各活动的有效性，发现方法本身的问题（analyzeMeta）
 *   3. 生成「元改进建议」（suggestMetaImprovement）
 *   4. 元技能版本管理（getMetaVersion / bumpMetaVersion）
 *
 * 设计原则：
 *   - 纯 Node 模块，存储路径经 agent-runtime paths 注入（getBaseDir）
 *   - 容错：任何异常都静默降级，绝不抛出、绝不改变现有行为
 *   - 存储：userData/knowledge/meta-stats.json / meta-skills.json
 */

const fs = require('fs');
const path = require('path');
const { getBaseDir } = require('../../core/agent-runtime/paths');

// ========== 配置 ==========

/** 元层统计保留的最大记录条数 */
const MAX_OUTCOMES = 500;

/** 元技能默认方法描述（v1 基线） */
const DEFAULT_METHODS = {
  retrospect: '规则分析轨迹 → 提取失败模式/耗时热点/重复调用 → 生成可优化点与 Prompt 模板。',
  forge: '从复盘发现生成技能草稿 → 结构校验 + 规则检查 + 模拟用例匹配 → 通过率达标后入库。',
  optimize: '基于使用数据（成功率/耗时）识别低效技能 → 给出优化或淘汰建议。',
};

/** 各活动的有效性阈值 */
const THRESHOLDS = {
  // 复盘建议采纳率（usefulScore 归一化后）低于此值 → 建议调整复盘 Prompt
  retrospectUsefulRate: 0.6,
  // 技能入库通过率低于此值 → 建议调整 validateSkill 阈值
  forgePassRate: 0.7,
  // 优化建议有效率低于此值 → 建议调整优化策略
  optimizeEffectRate: 0.6,
};

// ========== 路径 ==========

function getKnowledgeDir() {
  const dir = path.join(getBaseDir(), 'knowledge');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getStatsFile() {
  return path.join(getKnowledgeDir(), 'meta-stats.json');
}

function getMetaSkillsFile() {
  return path.join(getKnowledgeDir(), 'meta-skills.json');
}

function backupCorruptFile(file, reason) {
  try {
    if (!fs.existsSync(file)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(file, file + '.corrupt-' + stamp);
    console.error('[MetaEvolve] 文件损坏已备份(' + reason + '):', file);
  } catch (e) {}
}

// ========== 通用读写 ==========

function readJson(file, fallback, validate) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const obj = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (obj && validate(obj)) return obj;
    backupCorruptFile(file, '结构非法');
  } catch (err) {
    console.error('[MetaEvolve] 读取失败:', err.message);
    backupCorruptFile(file, 'JSON 解析失败');
  }
  return fallback;
}

function writeJson(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[MetaEvolve] 写入失败:', err.message);
    return false;
  }
}

function genId(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

// ========== 1. 元层统计 ==========

function readMetaStats() {
  return readJson(getStatsFile(), { outcomes: [] }, function (o) {
    return o && Array.isArray(o.outcomes);
  });
}

function writeMetaStats(obj) {
  return writeJson(getStatsFile(), obj);
}

/**
 * 记录一次自工程化活动的结果。
 * @param {object} opts
 *   - activity: 'retrospect' | 'forge' | 'optimize'
 *   - taskId?: string
 *   - success: boolean
 *   - usefulScore?: number（0-1，用于复盘建议采纳率近似）
 *   - note?: string
 * @returns {{ok:boolean, id?:string, reason?:string}}
 */
function recordMetaOutcome(opts) {
  try {
    const o = opts || {};
    const activity = String(o.activity || '').trim();
    if (!activity) return { ok: false, reason: 'activity 为空' };

    const entry = {
      id: genId('meta'),
      activity: activity,
      taskId: o.taskId ? String(o.taskId) : '',
      success: o.success !== false,
      usefulScore: (typeof o.usefulScore === 'number' && isFinite(o.usefulScore))
        ? Math.max(0, Math.min(1, o.usefulScore)) : null,
      note: o.note ? String(o.note).slice(0, 500) : '',
      createdAt: new Date().toISOString(),
    };

    const stats = readMetaStats();
    stats.outcomes.push(entry);
    // 超限按时间淘汰最旧
    if (stats.outcomes.length > MAX_OUTCOMES) {
      stats.outcomes = stats.outcomes.slice(stats.outcomes.length - MAX_OUTCOMES);
    }
    writeMetaStats(stats);
    return { ok: true, id: entry.id };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** 读取元层统计原始数据 */
function getMetaStats() {
  return readMetaStats();
}

// ========== 2. 元层分析 ==========

/** 计算某活动的统计摘要 */
function summarizeActivity(outcomes) {
  const total = outcomes.length;
  let success = 0, usefulSum = 0, usefulCount = 0;
  for (const o of outcomes) {
    if (o.success) success++;
    if (typeof o.usefulScore === 'number') { usefulSum += o.usefulScore; usefulCount++; }
  }
  return {
    activity: '',
    total: total,
    successCount: success,
    successRate: total ? success / total : 0,
    usefulCount: usefulCount,
    avgUsefulScore: usefulCount ? usefulSum / usefulCount : null,
  };
}

/**
 * 分析各活动的有效性，发现方法本身的问题。
 * @returns {{ok:boolean, activities:object, insights:Array}}
 */
function analyzeMeta() {
  try {
    const stats = readMetaStats();
    const byActivity = {};
    for (const o of stats.outcomes) {
      const a = o.activity || 'unknown';
      if (!byActivity[a]) byActivity[a] = [];
      byActivity[a].push(o);
    }

    const activities = {};
    for (const a of Object.keys(byActivity)) {
      const s = summarizeActivity(byActivity[a]);
      s.activity = a;
      activities[a] = s;
    }

    const insights = [];

    // retrospect：建议采纳率
    const r = activities.retrospect;
    if (r && r.total > 0) {
      const rate = r.avgUsefulScore;
      if (rate !== null && rate < THRESHOLDS.retrospectUsefulRate) {
        insights.push({
          activity: 'retrospect',
          level: 'warn',
          metric: 'avgUsefulScore',
          value: Math.round(rate * 100) / 100,
          threshold: THRESHOLDS.retrospectUsefulRate,
          message: '复盘建议采纳率偏低（' + Math.round(rate * 100) + '%），建议调整复盘 Prompt 的关注点。',
        });
      } else if (rate !== null) {
        insights.push({
          activity: 'retrospect',
          level: 'ok',
          metric: 'avgUsefulScore',
          value: Math.round(rate * 100) / 100,
          message: '复盘建议采纳率正常（' + Math.round(rate * 100) + '%）。',
        });
      }
    }

    // forge：技能入库通过率（用 success 近似）
    const f = activities.forge;
    if (f && f.total > 0) {
      if (f.successRate < THRESHOLDS.forgePassRate) {
        insights.push({
          activity: 'forge',
          level: 'warn',
          metric: 'successRate',
          value: Math.round(f.successRate * 100) / 100,
          threshold: THRESHOLDS.forgePassRate,
          message: '技能入库通过率偏低（' + Math.round(f.successRate * 100) + '%），建议放宽/收紧 validateSkill 的阈值。',
        });
      } else {
        insights.push({
          activity: 'forge',
          level: 'ok',
          metric: 'successRate',
          value: Math.round(f.successRate * 100) / 100,
          message: '技能入库通过率正常（' + Math.round(f.successRate * 100) + '%）。',
        });
      }
    }

    // optimize：优化建议有效性
    const op = activities.optimize;
    if (op && op.total > 0) {
      if (op.successRate < THRESHOLDS.optimizeEffectRate) {
        insights.push({
          activity: 'optimize',
          level: 'warn',
          metric: 'successRate',
          value: Math.round(op.successRate * 100) / 100,
          threshold: THRESHOLDS.optimizeEffectRate,
          message: '优化建议有效性偏低（' + Math.round(op.successRate * 100) + '%），建议调整优化策略（阈值/指标）。',
        });
      } else {
        insights.push({
          activity: 'optimize',
          level: 'ok',
          metric: 'successRate',
          value: Math.round(op.successRate * 100) / 100,
          message: '优化建议有效性正常（' + Math.round(op.successRate * 100) + '%）。',
        });
      }
    }

    return { ok: true, activities: activities, insights: insights };
  } catch (e) {
    return { ok: false, activities: {}, insights: [] };
  }
}

/**
 * 生成「元改进建议」（基于 analyzeMeta 的洞察）。
 * @returns {{ok:boolean, suggestions:Array<{activity,target,action,reason}>}}
 */
function suggestMetaImprovement() {
  try {
    const analysis = analyzeMeta();
    const suggestions = [];

    for (const ins of analysis.insights) {
      if (ins.level !== 'warn') continue;
      let action = '';
      let target = '';
      if (ins.activity === 'retrospect') {
        target = 'retrospect.buildRetrospectPrompt';
        action = '调整复盘 Prompt：把「必须产出 3 个可优化点」改为按问题严重度自适应，并在指令中明确要求方案可落地（含具体命令/参数）。';
      } else if (ins.activity === 'forge') {
        target = 'forge.validateSkill';
        action = '调整 validateSkill 阈值：如通过率过低则放宽 description 长度/触发词检查，过高则收紧模拟匹配率要求。';
      } else if (ins.activity === 'optimize') {
        target = 'skillEvolver.optimize';
        action = '调整优化策略：复核低效判定阈值（成功率/耗时），避免误判导致建议无效。';
      }
      suggestions.push({
        activity: ins.activity,
        target: target,
        action: action,
        reason: ins.message,
      });
    }

    return { ok: true, suggestions: suggestions };
  } catch (e) {
    return { ok: false, suggestions: [] };
  }
}

// ========== 3. 元技能版本管理 ==========

function readMetaSkills() {
  return readJson(getMetaSkillsFile(), null, function (o) {
    return o && o.current && Array.isArray(o.history);
  }) || {
    current: { version: 1, methods: Object.assign({}, DEFAULT_METHODS), updatedAt: new Date().toISOString(), reason: '初始版本' },
    history: [],
  };
}

function writeMetaSkills(obj) {
  return writeJson(getMetaSkillsFile(), obj);
}

/**
 * 获取元技能当前版本与方法描述。
 * @returns {{version:number, methods:object, updatedAt:string, reason:string}}
 */
function getMetaVersion() {
  try {
    const m = readMetaSkills();
    return m.current || { version: 1, methods: Object.assign({}, DEFAULT_METHODS), updatedAt: '', reason: '' };
  } catch (e) {
    return { version: 1, methods: Object.assign({}, DEFAULT_METHODS), updatedAt: '', reason: '' };
  }
}

/**
 * 升级元技能版本，记录改进原因与旧→新。
 * @param {string} reason 改进原因
 * @param {object} [patchMethods] 可选：覆盖的方法描述（{ activity: newText }）
 * @returns {{ok:boolean, version?:number, reason?:string}}
 */
function bumpMetaVersion(reason, patchMethods) {
  try {
    const m = readMetaSkills();
    const prev = m.current || { version: 1, methods: Object.assign({}, DEFAULT_METHODS), updatedAt: '', reason: '' };
    const oldMethods = Object.assign({}, prev.methods || DEFAULT_METHODS);
    const newMethods = Object.assign({}, oldMethods);
    if (patchMethods && typeof patchMethods === 'object') {
      for (const k of Object.keys(patchMethods)) {
        if (patchMethods[k]) newMethods[k] = String(patchMethods[k]);
      }
    }
    const next = {
      version: (typeof prev.version === 'number' ? prev.version : 1) + 1,
      methods: newMethods,
      updatedAt: new Date().toISOString(),
      reason: reason ? String(reason).slice(0, 500) : '',
    };
    m.history = Array.isArray(m.history) ? m.history : [];
    m.history.push({ from: prev.version, to: next.version, reason: next.reason, at: next.updatedAt });
    if (m.history.length > 100) m.history = m.history.slice(m.history.length - 100);
    m.current = next;
    writeMetaSkills(m);
    return { ok: true, version: next.version };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * 自动固化元改进建议（Level 3 核心：无人干预的"元技能进化"）
 *
 * 解决痛点：原来 suggestMetaImprovement 只给建议，要 AI 手动调 bumpMetaVersion 才生效
 * → 递归进化链断了。本函数在每日维护时自动执行：
 *   分析 → 若有明确 warn → 自动升级元技能版本（记录新方法描述）
 *
 * 保守策略：
 *   - 仅在"有 warn 洞察"时升级（无问题不动）
 *   - 每次都记录改进原因（可追溯/可回滚）
 *   - 版本号有上限（防无限递归，由 evolution-boundary.checkMetaDepth 守）
 *
 * @param {object} [opts]
 *   - maxVersion：版本上限（超过则不自动升，默认 50）
 * @returns {{applied:boolean, version?:number, appliedActivities?:string[], reason?:string}}
 */
function autoApplySuggestions(opts) {
  try {
    const o = opts || {};
    const maxVersion = typeof o.maxVersion === 'number' ? o.maxVersion : 50;

    const cur = getMetaVersion();
    if ((cur.version || 1) >= maxVersion) {
      return { applied: false, reason: '版本已达上限 ' + maxVersion + '，停止自动升级' };
    }

    const sug = suggestMetaImprovement();
    if (!sug || !sug.ok || !Array.isArray(sug.suggestions) || sug.suggestions.length === 0) {
      return { applied: false, reason: '无改进建议（各方法运行良好）' };
    }

    // 构造新方法描述：在原描述后追加"改进方向"
    const patchMethods = {};
    const appliedActivities = [];
    for (const s of sug.suggestions) {
      if (!s.activity || !s.action) continue;
      const oldText = (cur.methods && cur.methods[s.activity]) || '';
      patchMethods[s.activity] = oldText + ' 【改进】' + s.action;
      appliedActivities.push(s.activity);
    }
    if (appliedActivities.length === 0) {
      return { applied: false, reason: '建议无可固化项' };
    }

    const reason = '自动固化元改进（针对 ' + appliedActivities.join('、') + '）：' +
      sug.suggestions.map(function (x) { return x.reason; }).join('；').slice(0, 300);

    const res = bumpMetaVersion(reason, patchMethods);
    if (!res || !res.ok) return { applied: false, reason: (res && res.reason) || '升级失败' };

    return { applied: true, version: res.version, appliedActivities: appliedActivities, reason: reason };
  } catch (e) {
    return { applied: false, reason: e.message };
  }
}

/** 读取元技能版本历史 */
function getMetaHistory() {
  try {
    const m = readMetaSkills();
    return Array.isArray(m.history) ? m.history : [];
  } catch (e) {
    return [];
  }
}

module.exports = {
  recordMetaOutcome,
  getMetaStats,
  analyzeMeta,
  suggestMetaImprovement,
  getMetaVersion,
  bumpMetaVersion,
  getMetaHistory,
  autoApplySuggestions,
  MAX_OUTCOMES,
  DEFAULT_METHODS,
  THRESHOLDS,
};
