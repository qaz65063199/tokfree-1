'use strict';

/**
 * SkillForge —— 技能生成器（Agent 自工程化 Level 2 核心）
 *
 * 让 AI 从执行复盘中自动生成「可复用技能」，经沙盒结构验证后入库。
 *
 * 设计要点：
 * - 纯 Node 模块，仅依赖 src/main/knowledge.js（惰性 require，可注入便于测试）。
 * - 因运行环境无法真调 AI，验证采用「结构校验 + 规则检查 + 模拟用例」：
 *   name/description/content 合法性、description 触发词覆盖、模拟查询匹配率。
 * - 成功率 >= 80% 才允许入库，避免污染技能库。
 */

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 常见英文停用词（用于触发词提取） */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by',
  'is', 'are', 'be', 'as', 'at', 'it', 'this', 'that', 'from', 'use', 'used',
  'when', 'what', 'how', 'do', 'does', 'can', 'will', 'you', 'your', 'we',
  'i', 'its', 'into', 'via', 'per', 'not', 'no', 'so', 'than', 'then', 'them'
]);

/** 生成草稿时对 analysis 字段做容错读取 */
function pick(obj, keys, fallback) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
}

/** 将任意值规整为字符串数组 */
function toStringArray(v) {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((s) => s.trim() !== '');
  const s = String(v).trim();
  return s === '' ? [] : [s];
}

/** 把任意文本转成 kebab-case 技能名 */
function toKebabCase(text) {
  if (!text) return '';
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * 从一段描述文本中提取候选触发关键词。
 * 返回小写去重的单词数组，过滤停用词与极短词。
 */
function extractKeywords(text) {
  if (!text) return [];
  const words = String(text)
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return Array.from(new Set(words));
}

/**
 * 从复盘发现生成标准技能草稿。
 *
 * @param {object} analysis 复盘发现，容错字段：
 *   - name / title：技能名（可选，缺失则由 goal 推导）
 *   - goal / task / summary：任务目标
 *   - description：描述（缺失则据 goal 生成）
 *   - steps / procedure / actions：步骤（数组或字符串）
 *   - trigger / triggers / whenToUse：触发场景
 *   - tools：涉及工具
 *   - validate / validation：验证方式
 *   - fallback：失败回退
 * @returns {{name:string, description:string, content:string}}
 */
/** 安全转字符串：拒绝对象（防 [object Object]） */
function safeText(v, fallback) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'object') return fallback; // 不把对象拼进文本
  const s = String(v).trim();
  return s || fallback;
}

function buildSkillDraft(analysis) {
  // 兼容分析结果可能嵌套在 summary / findings 下
  const a = analysis || {};
  const src = (a.summary && typeof a.summary === 'object') ? Object.assign({}, a.summary, a) : a;
  const goal = safeText(pick(src, ['goal', 'task', 'objective', 'name', 'title'], ''), '') ||
               safeText(pick(a, ['goal', 'task', 'objective'], ''), '') ||
               '未命名技能';
  const rawName = safeText(pick(src, ['skillName', 'name', 'title'], ''), '') || goal;
  let name = toKebabCase(rawName);
  if (!name || name.length > 64) name = '';
  // 兜底：纯数字或过短时补前缀
  if (name && !/[a-z]/.test(name)) name = 'skill-' + name;
  // 中文/无法转 kebab-case：用唯一 hash 兜底（保证合法 + 不重名）
  if (!name) {
    let hash = 0;
    const seed = goal || rawName || String(Date.now());
    for (let i = 0; i < seed.length; i++) { hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0; }
    name = 'auto-skill-' + Math.abs(hash).toString(36).slice(0, 6);
  }

  const steps = toStringArray(pick(src, ['steps', 'procedure', 'actions', 'howto'], []));
  const triggers = toStringArray(pick(src, ['trigger', 'triggers', 'whenToUse', 'when'], []));
  const tools = toStringArray(pick(src, ['tools', 'tool'], []));
  const validate = safeText(pick(src, ['validate', 'validation', 'verify'], ''), '');
  const fallback = safeText(pick(src, ['fallback', 'onFailure'], ''), '');

  // 构造 description：做什么 + 何时用
  let description = safeText(pick(src, ['description'], ''), '');
  if (!description) {
    const what = goal.replace(/\s+/g, ' ').slice(0, 120);
    const when = triggers.length > 0 ? triggers.join(', ') : goal;
    description = `${what}. Use when ${when}.`;
  }
  // 保证含 Use when 触发短语
  if (!/use when/i.test(description)) {
    const when = triggers.length > 0 ? triggers.join(', ') : goal;
    description = `${description.replace(/[.。]\s*$/, '')}. Use when ${when}.`;
  }
  description = description.replace(/\s+/g, ' ').slice(0, 1024).trim();

  // 构造正文
  const lines = [];
  lines.push(`# ${goal.replace(/\s+/g, ' ')}`);
  lines.push('');
  lines.push('## 何时使用');
  lines.push(triggers.length > 0 ? triggers.map((t) => `- ${t}`).join('\n') : `- ${goal}`);
  lines.push('');
  lines.push('## 步骤');
  if (steps.length > 0) {
    steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  } else {
    lines.push('1. （请补充具体步骤）');
  }
  if (tools.length > 0) {
    lines.push('');
    lines.push('## 涉及工具');
    tools.forEach((t) => lines.push(`- ${t}`));
  }
  if (validate) {
    lines.push('');
    lines.push('## 验证');
    lines.push(validate);
  }
  if (fallback) {
    lines.push('');
    lines.push('## 失败回退');
    lines.push(fallback);
  }

  return { name, description, content: lines.join('\n') };
}

/** 单项校验结果 */
function check(name, passed, detail) {
  return { name, passed: !!passed, detail: detail || '' };
}

/**
 * 沙盒验证技能草稿。
 *
 * 采用「结构校验 + 规则检查 + 模拟用例」：
 *  1. name 合法（kebab-case、长度）
 *  2. description 含 what + when、长度合理
 *  3. content 非空、有步骤
 *  4. 模拟用例：description 关键词能否匹配测试查询
 *
 * @param {object} draft {name, description, content}
 * @param {object} [opts]
 *   - queries：自定义测试查询数组；缺省则由 description 反向生成
 * @returns {{passed:boolean, score:number, checks:Array, reason:string}}
 */
function validateSkill(draft, opts) {
  opts = opts || {};
  const d = draft || {};
  const name = String(d.name || '');
  const description = String(d.description || '');
  const content = String(d.content || '');
  const checks = [];

  // 0. 垃圾内容检测（防 buildSkillDraft 对异常输入生成 [object Object] 等）
  // 只拒真正的垃圾（[object Object]/undefined/NaN）；auto-skill-xxx 是合法兜底名
  const hasGarbage = /\[object Object\]|undefined|NaN/i.test(name + ' ' + description + ' ' + content);
  checks.push(check('no-garbage', !hasGarbage, hasGarbage ? '含垃圾内容（[object Object]/undefined/NaN）' : 'ok'));

  // 1. name
  const nameOk = NAME_RE.test(name) && name.length >= 1 && name.length <= 64;
  checks.push(check('name', nameOk, nameOk ? name : `非法 name: "${name}"（需 kebab-case，1-64 字符）`));

  // 2. description
  const descNonEmpty = description.trim().length > 0;
  const descLenOk = description.length >= 20 && description.length <= 1024;
  const hasWhen = /use when|当.*时|when /i.test(description);
  checks.push(check('description.present', descNonEmpty, descNonEmpty ? 'ok' : 'description 为空'));
  checks.push(check('description.length', descLenOk, `长度 ${description.length}`));
  checks.push(check('description.trigger', hasWhen, hasWhen ? 'ok' : '缺少 "Use when" 触发短语'));

  // 3. content
  const contentNonEmpty = content.trim().length > 0;
  const hasSteps = /(^|\n)\s*(\d+\.|[-*])\s+\S/m.test(content) || /步骤|step/i.test(content);
  checks.push(check('content.present', contentNonEmpty, contentNonEmpty ? 'ok' : 'content 为空'));
  checks.push(check('content.steps', hasSteps, hasSteps ? 'ok' : 'content 缺少步骤列表'));

  // 4. 触发测试（正例 + 负例）
  //   正例：应该触发本技能的任务描述 → 匹配率应高
  //   负例：不该触发本技能的任务描述 → 匹配率应低（否则说明技能"太宽泛"，会误触发）
  //
  //   ⚠️ 关键修正：旧实现从 description 反向生成 query 再匹配 description，
  //   必然全中（循环论证）。现改为：正例用 description 关键词（仍有意义，
  //   验证关键词提取有效），并新增**负例**（通用无关任务）检测误触发。
  const keywords = extractKeywords(description);
  const kwSet = new Set(keywords);

  // 正例：优先用外部传入，否则从 description 自身生成（基础自检）
  let positive = Array.isArray(opts.queries) ? opts.queries.filter((q) => String(q).trim() !== '') : null;
  if (!positive || positive.length === 0) {
    const goalPhrase = description.split(/[.。]/)[0] || description;
    positive = [goalPhrase].filter((q) => String(q).trim() !== '');
  }
  let posMatched = 0;
  for (const q of positive) {
    const qk = extractKeywords(q);
    if (qk.some((w) => kwSet.has(w)) || String(q).toLowerCase().indexOf(name.toLowerCase()) !== -1) posMatched++;
  }
  const posRate = positive.length > 0 ? posMatched / positive.length : 0;
  const posOk = positive.length > 0 && posRate >= 0.8;
  checks.push(check('trigger.positive', posOk, `正例匹配 ${posMatched}/${positive.length}（${Math.round(posRate * 100)}%）`));

  // 负例：通用无关任务（中英双语，确保无论描述是中文还是英文都能检出误触发）
  const negativeDefault = [
    '写一首诗', '查询今天的天气', '翻译一段英文', '画一张图', '推荐一部电影',
    'write a poem', 'check today weather', 'translate a paragraph', 'draw a picture', 'recommend a movie',
  ];
  const negative = Array.isArray(opts.negativeQueries) ? opts.negativeQueries.filter((q) => String(q).trim() !== '') : negativeDefault;
  // 前缀匹配（应对英文词形变化：poem/poems、movie/movies、translate/translation）
  const kwArr = Array.from(kwSet);
  const hitAny = (words) => words.some((w) => kwArr.some((k) => k === w || k.indexOf(w) === 0 || w.indexOf(k) === 0));
  let falsePositive = 0;
  for (const q of negative) {
    const qk = extractKeywords(q);
    if (qk.length > 0 && hitAny(qk)) falsePositive++;
  }
  const fpRate = negative.length > 0 ? falsePositive / negative.length : 0;
  const negOk = fpRate <= 0.2; // 误触发率 ≤20%
  checks.push(check('trigger.negative', negOk, `负例误触发 ${falsePositive}/${negative.length}（${Math.round(fpRate * 100)}%，需 ≤20%）`));

  // 兼容旧字段
  const matchRate = posRate;
  const simOk = posOk && negOk;

  // 评分：通过项占比
  const passedCount = checks.filter((c) => c.passed).length;
  const score = checks.length > 0 ? passedCount / checks.length : 0;
  const passed = !hasGarbage && simOk && nameOk && descNonEmpty && descLenOk && hasWhen && contentNonEmpty && hasSteps;
  // simOk = 正例命中 + 负例不误触发

  const failed = checks.filter((c) => !c.passed).map((c) => c.detail || c.name);
  const reason = passed
    ? `验证通过（得分 ${Math.round(score * 100)}%，模拟匹配率 ${Math.round(matchRate * 100)}%）`
    : `验证未通过：${failed.join('；')}`;

  return { passed, score, checks, reason };
}

/** 惰性获取 knowledge 模块（可注入） */
function resolveKnowledge(opts) {
  if (opts && opts.knowledge) return opts.knowledge;
  return require('../knowledge.js');
}

/**
 * 验证通过后入库。
 *
 * @param {object} draft {name, description, content}
 * @param {object} [opts]
 *   - knowledge：注入的 knowledge 模块（测试用）
 *   - queries：传给 validateSkill 的模拟查询
 *   - minScore：入库阈值（默认 0.8，即通过项占比）
 *   - enabled：入库后是否在本项目启用（默认 false）
 * @returns {{ok:boolean, name:string, validation:object, reason:string}}
 */
function forgeSkill(draft, opts) {
  opts = opts || {};
  const d = draft || {};
  const minScore = typeof opts.minScore === 'number' ? opts.minScore : 0.8;

  const validation = validateSkill(d, opts);
  if (!validation.passed || validation.score < minScore) {
    return {
      ok: false,
      name: d.name || '',
      validation,
      reason: `拒绝入库：${validation.reason}（阈值 ${Math.round(minScore * 100)}%，实际 ${Math.round(validation.score * 100)}%）`,
    };
  }

  let knowledge;
  try {
    knowledge = resolveKnowledge(opts);
  } catch (err) {
    return { ok: false, name: d.name || '', validation, reason: `无法加载知识库模块：${err.message}` };
  }

  if (!knowledge || typeof knowledge.createSkill !== 'function') {
    return { ok: false, name: d.name || '', validation, reason: '知识库模块缺少 createSkill' };
  }

  try {
    knowledge.createSkill(d.name, d.content, { description: d.description });
  } catch (err) {
    return { ok: false, name: d.name || '', validation, reason: `入库失败：${err.message}` };
  }

  if (opts.enabled && typeof knowledge.enableSkill === 'function') {
    try { knowledge.enableSkill(d.name); } catch (_) { /* 启用失败不阻断入库 */ }
  }

  return { ok: true, name: d.name, validation, reason: `已入库技能 ${d.name}（得分 ${Math.round(validation.score * 100)}%）` };
}

module.exports = {
  NAME_RE,
  toKebabCase,
  extractKeywords,
  buildSkillDraft,
  validateSkill,
  forgeSkill,
};
