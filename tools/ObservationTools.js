/**
 * 观察日志工具层（Observational Memory）
 *
 * 封装 src/main/observations.js 的能力，供 AI 通过 JS 沙箱调用：
 *   observation_add / observation_list / observation_merge
 *
 * 说明：当前调用方的 profileId 由 JsRunner 在调用工具时自动注入到参数 p.__callerProfileId。
 */
const { Tool, ToolResult } = require('./ToolRegistry');
const observations = require('../src/main/observations');

/** 达到该观察数时，提示 AI 调用 observation_merge 归纳 */
const MERGE_SUGGEST_THRESHOLD = 15;

// 内部：从工具参数取调用方 profileId（JsRunner 自动注入）
function currentProfileId(p) {
  return (p && p.__callerProfileId) || null;
}

// ========== observation_add ==========
class ObservationAddTool extends Tool {
  constructor() {
    super('observation_add', '记录一条观察（决策/偏好/踩坑/待办/上下文），长期沉淀、跨会话注入',
      { type: 'object', properties: {
        category: { type: 'string', description: '观察类别（中文合法值）：决策 / 偏好 / 踩坑 / 待办 / 上下文' },
        summary: { type: 'string', description: '观察内容（简明一句话）' }
      }, required: ['category', 'summary'] },
      'observation_add(category, summary)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.category || !p.summary) return ToolResult.error('缺少 category 或 summary');
      const pid = currentProfileId(p);
      const res = observations.addObservation(pid, { category: p.category, summary: p.summary });
      if (res && res.success === false) return ToolResult.error(res.error || '记录观察失败');
      let count = 0;
      try { count = observations.listObservations(pid, 1000).length; } catch (_) {}
      let message = '已记录观察（' + p.category + '）。当前共 ' + count + ' 条观察。';
      if (count >= MERGE_SUGGEST_THRESHOLD) {
        message += ' 观察已达 ' + count + ' 条（≥' + MERGE_SUGGEST_THRESHOLD + '），建议调用 observation_merge(summary) 归纳出高层结论。';
      }
      return ToolResult.success({ id: res && res.id, count: count, message: message });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== observation_list ==========
class ObservationListTool extends Tool {
  constructor() {
    super('observation_list', '列出本 profile 最近的观察记录',
      { type: 'object', properties: {
        limit: { type: 'number', description: '返回条数上限，默认 10' }
      } },
      'observation_list(limit)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      const pid = currentProfileId(p);
      const limit = (p && typeof p.limit === 'number' && p.limit > 0) ? p.limit : 10;
      const list = observations.listObservations(pid, limit);
      return ToolResult.success({ total: list.length, observations: list });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== observation_merge ==========
class ObservationMergeTool extends Tool {
  constructor() {
    super('observation_merge', '把累积的观察归纳为一条高层反思（Reflector）',
      { type: 'object', properties: {
        summary: { type: 'string', description: '归纳出的高层结论/反思' }
      }, required: ['summary'] },
      'observation_merge(summary)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.summary) return ToolResult.error('缺少 summary');
      const pid = currentProfileId(p);
      const res = observations.addReflection(pid, p.summary);
      if (res && res.success === false) return ToolResult.error(res.error || '记录反思失败');
      return ToolResult.success({ id: res && res.id, merged: true });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

module.exports = {
  ObservationAddTool,
  ObservationListTool,
  ObservationMergeTool,
  MERGE_SUGGEST_THRESHOLD,
};
