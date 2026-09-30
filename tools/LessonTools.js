/**
 * 教训记忆工具层（Reflexion 式自进化）
 *
 * 封装 src/main/lessons.js 的能力，供 AI 通过 JS 沙箱调用：
 *   lesson_record / lesson_list / lesson_delete / lesson_search
 *
 * 说明：当前项目目录由 JsRunner 在调用工具时自动注入到参数 p.projectDir。
 */
const { Tool, ToolResult } = require('./ToolRegistry');
const lessons = require('../src/main/lessons');

// 内部：从工具参数取当前项目目录（JsRunner 自动注入）
function currentProjectDir(p) {
  return (p && p.projectDir) || null;
}

// ========== lesson_record ==========
class LessonRecordTool extends Tool {
  constructor() {
    super('lesson_record', '记录一条教训（任务失败/被纠正后沉淀，供下次同类任务主动注入）',
      { type: 'object', properties: {
        lesson: { type: 'string', description: '一句话教训（做什么/别做什么 + 原因）' },
        context: { type: 'string', description: '触发场景（什么任务/什么错误下学到的）' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选，关键词标签' },
        scope: { type: 'string', description: "作用域：global（默认，跨项目）或 project（仅当前项目）" }
      }, required: ['lesson', 'context'] },
      'lesson_record(lesson, context, tags, scope)');
  }
  getPromptSection() {
    return {
      name: 'tool:lesson',
      order: 116,
      text: [
        '## 教训记忆（lesson_*）',
        '任务失败、被用户纠正、或发现更好的做法时，主动调 lesson_record(lesson, context, tags?, scope?) 沉淀一条教训；下次同类任务初始化时会自动注入，避免重蹈覆辙。',
        '- lesson_record(lesson, context, tags, scope) — 记录教训（scope 默认 global，传 project 仅当前项目）',
        '- lesson_list() — 列出全部教训',
        '- lesson_search(keywords, limit?) — 按关键词检索相关教训',
        '- lesson_delete(id) — 删除一条教训'
      ].join('\n')
    };
  }
  async execute(p) {
    try {
      if (!p || !p.lesson || !p.context) return ToolResult.error('缺少 lesson 或 context');
      let scope = p.scope || 'global';
      let projectDir = null;
      if (scope === 'project') {
        projectDir = currentProjectDir(p);
        if (!projectDir) return ToolResult.error('scope=project 但未找到当前项目目录，请先初始化项目');
        scope = projectDir;
      } else {
        scope = 'global';
      }
      const res = lessons.recordLesson({
        lesson: p.lesson,
        context: p.context,
        tags: Array.isArray(p.tags) ? p.tags : [],
        scope,
        projectDir
      });
      if (res && res.success === false) return ToolResult.error(res.error || '记录教训失败');
      return ToolResult.success(res && res.lesson ? res : { id: res && res.id });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== lesson_list ==========
class LessonListTool extends Tool {
  constructor() {
    super('lesson_list', '列出全部教训',
      { type: 'object', properties: {} },
      'lesson_list()');
  }
  getPromptSection() { return null; }
  async execute() {
    try {
      const list = lessons.listLessons();
      return ToolResult.success({ total: list.length, lessons: list });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== lesson_delete ==========
class LessonDeleteTool extends Tool {
  constructor() {
    super('lesson_delete', '删除一条教训（不可恢复）',
      { type: 'object', properties: { id: { type: 'string', description: '教训 id' } }, required: ['id'] },
      'lesson_delete(id)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.id) return ToolResult.error('缺少教训 id');
      const res = lessons.deleteLesson(p.id);
      if (res && res.success === false) return ToolResult.error(res.error || '删除教训失败');
      return ToolResult.success({ id: p.id, deleted: true });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== lesson_search ==========
class LessonSearchTool extends Tool {
  constructor() {
    super('lesson_search', '按关键词检索相关教训',
      { type: 'object', properties: {
        keywords: { type: 'array', items: { type: 'string' }, description: '关键词列表' },
        limit: { type: 'number', description: '返回条数上限，默认 5' }
      }, required: ['keywords'] },
      'lesson_search(keywords, limit)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !Array.isArray(p.keywords) || p.keywords.length === 0) return ToolResult.error('缺少关键词 keywords（数组）');
      const dir = currentProjectDir(p);
      const limit = typeof p.limit === 'number' && p.limit > 0 ? p.limit : 5;
      const list = lessons.matchLessons(dir, p.keywords, limit);
      return ToolResult.success({ total: list.length, lessons: list });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

module.exports = {
  LessonRecordTool,
  LessonListTool,
  LessonDeleteTool,
  LessonSearchTool,
};
