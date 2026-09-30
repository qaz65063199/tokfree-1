/**
 * 自工程化工具层（AutoEng）—— 让 AI 调用自工程化能力
 *
 * 封装 src/main/team/ 下 4 个自工程化模块，供 AI 通过 JS 沙箱调用：
 *   trace.js        — 执行轨迹：auto_trace_list / auto_trace_get
 *   retrospect.js   — 复盘引擎：auto_retrospect
 *   skill-forge.js  — 技能生成：auto_skill_forge / auto_skill_forge_commit
 *   skill-evolver.js— 技能迭代淘汰：auto_skill_stats / auto_skill_archive_pass / auto_skill_record_usage
 *
 * 设计原则：
 *   - 纯工具封装，不改变自工程化模块本身行为
 *   - 每个 execute 内 try/catch，统一返回 ToolResult
 *   - getPromptSection 返回 null（自工程化说明由知识库章节统一注入，避免重复）
 *   - 惰性 require team 模块，避免在非 Electron 环境（测试）下顶层加载 electron
 */
const { Tool, ToolResult } = require('./ToolRegistry');

// 惰性加载自工程化模块（这些模块内部依赖 electron app.getPath，顶层 require 会失败）
function loadTrace() { return require('../src/main/team/trace'); }
function loadRetrospect() { return require('../src/main/team/retrospect'); }
function loadSkillForge() { return require('../src/main/team/skill-forge'); }
function loadSkillEvolver() { return require('../src/main/team/skill-evolver'); }

// ========== auto_trace_list ==========
class AutoTraceListTool extends Tool {
  constructor() {
    super('auto_trace_list', '列出最近执行轨迹（自工程化：执行历史）',
      { type: 'object', properties: { limit: { type: 'number', description: '返回条数上限（可选）' } } },
      'auto_trace_list(limit?)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      const limit = p && typeof p.limit === 'number' ? p.limit : undefined;
      const traces = loadTrace().listTraces(limit);
      return ToolResult.success({ total: traces.length, traces });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== auto_trace_get ==========
class AutoTraceGetTool extends Tool {
  constructor() {
    super('auto_trace_get', '读取某条执行轨迹详情',
      { type: 'object', properties: { taskId: { type: 'string', description: '任务 ID' } }, required: ['taskId'] },
      'auto_trace_get(taskId)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.taskId) return ToolResult.error('缺少 taskId');
      const t = loadTrace().getTrace(p.taskId);
      if (!t) return ToolResult.error('轨迹不存在: ' + p.taskId);
      return ToolResult.success({ trace: t });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== auto_retrospect ==========
class AutoRetrospectTool extends Tool {
  constructor() {
    super('auto_retrospect', '复盘某条执行轨迹（规则分析 + 复盘 Prompt）',
      { type: 'object', properties: { taskId: { type: 'string', description: '任务 ID' } }, required: ['taskId'] },
      'auto_retrospect(taskId)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.taskId) return ToolResult.error('缺少 taskId');
      const r = loadRetrospect();
      const analysis = r.analyzeTrace(p.taskId);
      const prompt = r.buildRetrospectPrompt(p.taskId);
      if (!analysis || analysis.ok === false) {
        return ToolResult.error('无法复盘轨迹（轨迹不存在或无步骤）: ' + p.taskId);
      }
      return ToolResult.success({ taskId: p.taskId, analysis, prompt });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== auto_skill_forge ==========
class AutoSkillForgeTool extends Tool {
  constructor() {
    super('auto_skill_forge', '从复盘发现生成技能草稿并验证（不直接入库）',
      { type: 'object', properties: {
        analysis: { type: 'object', description: '复盘发现对象（含 goal/steps/triggers 等字段）' }
      }, required: ['analysis'] },
      'auto_skill_forge(analysis)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.analysis || typeof p.analysis !== 'object') return ToolResult.error('缺少 analysis 对象');
      const forge = loadSkillForge();
      const draft = forge.buildSkillDraft(p.analysis);
      const validation = forge.validateSkill(draft);
      return ToolResult.success({ draft, validation, passed: validation.passed });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== auto_skill_forge_commit ==========
class AutoSkillForgeCommitTool extends Tool {
  constructor() {
    super('auto_skill_forge_commit', '验证通过则把技能草稿入库（自工程化：技能沉淀）',
      { type: 'object', properties: {
        draft: { type: 'object', description: '技能草稿 {name, description, content}' }
      }, required: ['draft'] },
      'auto_skill_forge_commit(draft)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.draft || typeof p.draft !== 'object') return ToolResult.error('缺少 draft 对象');
      const res = loadSkillForge().forgeSkill(p.draft);
      if (!res.ok) return ToolResult.error(res.reason || '入库失败');
      return ToolResult.success({ name: res.name, validation: res.validation, reason: res.reason });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== auto_skill_stats ==========
class AutoSkillStatsTool extends Tool {
  constructor() {
    super('auto_skill_stats', '技能使用统计与优化/淘汰建议（自工程化：技能迭代）',
      { type: 'object', properties: {} },
      'auto_skill_stats()');
  }
  getPromptSection() { return null; }
  async execute() {
    try {
      const report = loadSkillEvolver().analyze();
      return ToolResult.success(report);
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== auto_skill_archive_pass ==========
class AutoSkillArchivePassTool extends Tool {
  constructor() {
    super('auto_skill_archive_pass', '执行技能淘汰归档（长期低效技能移入归档）',
      { type: 'object', properties: {} },
      'auto_skill_archive_pass()');
  }
  getPromptSection() { return null; }
  async execute() {
    try {
      const res = loadSkillEvolver().runArchivePass();
      return ToolResult.success(res);
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== auto_skill_record_usage ==========
class AutoSkillRecordUsageTool extends Tool {
  constructor() {
    super('auto_skill_record_usage', '记录一次技能使用（成功/失败/耗时），驱动迭代淘汰',
      { type: 'object', properties: {
        name: { type: 'string', description: '技能名' },
        success: { type: 'boolean', description: '本次使用是否成功' },
        durationMs: { type: 'number', description: '耗时毫秒（可选）' }
      }, required: ['name', 'success'] },
      'auto_skill_record_usage(name, success, durationMs?)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.name) return ToolResult.error('缺少技能名 name');
      const res = loadSkillEvolver().recordUsage(p.name, {
        success: p.success !== false,
        durationMs: typeof p.durationMs === 'number' ? p.durationMs : undefined,
      });
      if (!res.success) return ToolResult.error(res.error || '记录失败');
      return ToolResult.success({ name: p.name, stat: res.stat });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== 自驱循环工具（无人干预持续进化）==========
function loadSelfLoop() { return require('../src/main/team/self-loop'); }

// auto_goal_create — 创建目标（人类设一次，循环自己追）
class AutoGoalCreateTool extends Tool {
  constructor() {
    super('auto_goal_create', '创建自驱循环目标（人类设定一次，系统无人干预持续追到达标）',
      { type: 'object', properties: {
        title: { type: 'string', description: '目标标题' },
        successCriteria: { type: 'array', items: { type: 'string' }, description: '达标标准（每条一个可验证条件）' },
        maxRounds: { type: 'number', description: '最大轮次（默认20）' },
        maxMs: { type: 'number', description: '最长运行毫秒（默认6小时）' },
        testQueries: { type: 'array', items: { type: 'string' }, description: '测试查询（可选）' },
      }, required: ['title'] },
      'auto_goal_create(title, successCriteria?, maxRounds?, maxMs?)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.title) return ToolResult.error('缺少 title');
      const res = loadSelfLoop().createGoal({
        title: p.title, successCriteria: p.successCriteria,
        maxRounds: p.maxRounds, maxMs: p.maxMs,
        testQueries: p.testQueries, profileId: p.__callerProfileId || '',
      });
      if (!res.success) return ToolResult.error(res.error || '创建失败');
      return ToolResult.success({ goal: res.goal, hint: '目标已建立。系统会无人干预地持续推进，直到达标或达到上限。' });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// auto_goal_list — 列目标
class AutoGoalListTool extends Tool {
  constructor() {
    super('auto_goal_list', '列出自驱循环目标及进度',
      { type: 'object', properties: { status: { type: 'string', description: 'running|achieved|exhausted|aborted（可选）' } } },
      'auto_goal_list(status?)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      const goals = loadSelfLoop().listGoals(p && p.status ? { status: p.status } : {});
      return ToolResult.success({ total: goals.length, goals: goals });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// auto_goal_status — 看某目标详情
class AutoGoalStatusTool extends Tool {
  constructor() {
    super('auto_goal_status', '查看自驱循环目标详情与下一轮决策',
      { type: 'object', properties: { goalId: { type: 'string' } }, required: ['goalId'] },
      'auto_goal_status(goalId)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.goalId) return ToolResult.error('缺少 goalId');
      const sl = loadSelfLoop();
      const g = sl.getGoal(p.goalId);
      if (!g) return ToolResult.error('目标不存在');
      return ToolResult.success({ goal: g, nextAction: sl.decideNextAction(p.goalId), nextPrompt: sl.buildNextRoundPrompt(p.goalId) });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// auto_goal_round — 记录一轮（AI 每轮结束时调用，含达标证据）
class AutoGoalRoundTool extends Tool {
  constructor() {
    super('auto_goal_round', '记录自驱循环的一轮（执行结果 + 达标证据），系统据此判定是否继续',
      { type: 'object', properties: {
        goalId: { type: 'string' },
        criteriaResults: { type: 'object', description: '各达标标准的判定 {标准: true/false}' },
        aiScore: { type: 'number', description: 'AI 自评分 0-1（无显式标准时用）' },
        actions: { type: 'array', items: { type: 'string' }, description: '本轮做了什么（retrospect/forge/optimize 等）' },
        note: { type: 'string', description: '备注' },
      }, required: ['goalId'] },
      'auto_goal_round(goalId, criteriaResults?, aiScore?, actions?, note?)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.goalId) return ToolResult.error('缺少 goalId');
      const res = loadSelfLoop().recordRound(p.goalId, {
        evidence: { criteriaResults: p.criteriaResults, aiScore: p.aiScore },
        actions: p.actions, note: p.note,
      });
      if (!res.success) return ToolResult.error(res.error || '记录失败');
      return ToolResult.success({
        goal: { id: res.goal.id, status: res.goal.status, round: res.goal.round, bestScore: res.goal.bestScore },
        evaluation: res.evaluation,
        hint: res.evaluation.achieved ? '🎉 目标已达标，循环停止。' : '未达标，循环将继续下一轮。',
      });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// auto_goal_abort — 中止目标
class AutoGoalAbortTool extends Tool {
  constructor() {
    super('auto_goal_abort', '中止自驱循环目标',
      { type: 'object', properties: { goalId: { type: 'string' }, reason: { type: 'string' } }, required: ['goalId'] },
      'auto_goal_abort(goalId, reason?)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.goalId) return ToolResult.error('缺少 goalId');
      const res = loadSelfLoop().abortGoal(p.goalId, p.reason);
      if (!res.success) return ToolResult.error(res.error || '中止失败');
      return ToolResult.success({ aborted: true, goalId: p.goalId });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== meta-evolve 元技能进化工具（Level 3）==========
function loadMetaEvolve() { return require('../src/main/team/meta-evolve'); }

// auto_meta_record — 记录一次自工程化活动的结果
class AutoMetaRecordTool extends Tool {
  constructor() {
    super('auto_meta_record', '记录一次自工程化活动结果（供元层分析）',
      { type: 'object', properties: {
        activity: { type: 'string', description: 'retrospect|forge|optimize' },
        taskId: { type: 'string', description: '任务 ID（可选）' },
        success: { type: 'boolean', description: '本次活动是否成功' },
        usefulScore: { type: 'number', description: '有用程度 0-1（可选）' },
        note: { type: 'string', description: '备注（可选）' },
      }, required: ['activity', 'success'] },
      'auto_meta_record(activity, success, usefulScore?, taskId?, note?)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.activity) return ToolResult.error('缺少 activity');
      const res = loadMetaEvolve().recordMetaOutcome({
        activity: p.activity, taskId: p.taskId, success: p.success !== false,
        usefulScore: typeof p.usefulScore === 'number' ? p.usefulScore : undefined, note: p.note,
      });
      if (res && res.success === false) return ToolResult.error(res.error || '记录失败');
      return ToolResult.success(res || { ok: true });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// auto_meta_analyze — 分析元层效果 + 生成元改进建议
class AutoMetaAnalyzeTool extends Tool {
  constructor() {
    super('auto_meta_analyze', '分析自工程化方法本身的效果，给出元改进建议（Level 3）',
      { type: 'object', properties: {} },
      'auto_meta_analyze()');
  }
  getPromptSection() { return null; }
  async execute() {
    try {
      const meta = loadMetaEvolve();
      const analysis = meta.analyzeMeta();
      const suggestions = meta.suggestMetaImprovement();
      return ToolResult.success({ analysis: analysis, suggestions: suggestions });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// auto_meta_version — 查/升元技能版本
class AutoMetaVersionTool extends Tool {
  constructor() {
    super('auto_meta_version', '查看当前元技能（方法）版本与历史',
      { type: 'object', properties: {} },
      'auto_meta_version()');
  }
  getPromptSection() { return null; }
  async execute() {
    try {
      const meta = loadMetaEvolve();
      return ToolResult.success({ current: meta.getMetaVersion(), history: meta.getMetaHistory() });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// auto_meta_bump — 升级元技能版本（改进"方法本身"）
class AutoMetaBumpTool extends Tool {
  constructor() {
    super('auto_meta_bump', '升级元技能版本（记录对"方法本身"的改进）',
      { type: 'object', properties: {
        reason: { type: 'string', description: '改进原因' },
        patchMethods: { type: 'object', description: '可选：要更新的方法描述 {retrospect?, forge?, optimize?}' },
      }, required: ['reason'] },
      'auto_meta_bump(reason, patchMethods?)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.reason) return ToolResult.error('缺少 reason');
      const res = loadMetaEvolve().bumpMetaVersion(p.reason, p.patchMethods);
      if (res && res.success === false) return ToolResult.error(res.error || '升级失败');
      return ToolResult.success(res || { ok: true });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

module.exports = {
  AutoTraceListTool,
  AutoTraceGetTool,
  AutoRetrospectTool,
  AutoSkillForgeTool,
  AutoSkillForgeCommitTool,
  AutoSkillStatsTool,
  AutoSkillArchivePassTool,
  AutoSkillRecordUsageTool,
  AutoMetaRecordTool,
  AutoMetaAnalyzeTool,
  AutoMetaVersionTool,
  AutoMetaBumpTool,
  AutoGoalCreateTool,
  AutoGoalListTool,
  AutoGoalStatusTool,
  AutoGoalRoundTool,
  AutoGoalAbortTool,
};
