/**
 * 技能工具层（跨项目知识库）
 *
 * 封装 src/main/knowledge.js 的能力，供 AI 通过 JS 沙箱调用：
 *   skill_list / skill_list_enabled / skill_read / skill_create / skill_update
 *   skill_delete / skill_enable / skill_disable
 *   preference_read / preference_append
 *
 * 说明：当前项目目录由 JsRunner 在调用工具时自动注入到参数 p.projectDir。
 * 技能库的整体说明已由 knowledge.buildKnowledgeSection 注入提示词，
 * 故此处 getPromptSection 返回 null（避免重复注入）。
 */
const { Tool, ToolResult } = require('./ToolRegistry');
const knowledge = require('../src/main/knowledge');

// 内部：从工具参数取当前项目目录（JsRunner 自动注入）
function currentProjectDir(p) {
  return (p && p.projectDir) || null;
}

// 内部：技能使用埋点（记录到 skill-evolver，供迭代/淘汰分析）
// - 惰性 require（skill-evolver 依赖 electron app.getPath，顶层加载会失败）
// - 失败静默：埋点绝不影响技能工具主流程
function recordSkillUsage(name, success) {
  if (!name || typeof name !== 'string') return;
  try {
    require('../src/main/team/skill-evolver').recordUsage(name, { success: success !== false });
  } catch (e) { /* 埋点失败静默，不影响主流程 */ }
}

// ========== skill_list ==========
class SkillListTool extends Tool {
  constructor() {
    super('skill_list', '列出全部技能（跨项目共享的技能库）',
      { type: 'object', properties: {} },
      'skill_list()');
  }
  getPromptSection() { return null; }
  async execute() {
    try {
      const skills = knowledge.listSkills();
      return ToolResult.success({ total: skills.length, skills });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== skill_list_enabled ==========
class SkillListEnabledTool extends Tool {
  constructor() {
    super('skill_list_enabled', '列出本项目已启用的技能',
      { type: 'object', properties: {} },
      'skill_list_enabled()');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      const dir = currentProjectDir(p);
      if (!dir) return ToolResult.error('未找到当前项目目录，请先初始化项目');
      const names = knowledge.getEnabledSkills(dir);
      const byName = {};
      for (const s of knowledge.listSkills()) byName[s.name] = s;
      const skills = names.map(n => byName[n] || { name: n });
      // 注意：列出≠使用，此处不埋点（避免统计虚高）。真正使用在 skill_read 时记录。
      return ToolResult.success({ projectDir: dir, total: skills.length, skills });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== skill_read ==========
class SkillReadTool extends Tool {
  constructor() {
    super('skill_read', '读取某个技能全文',
      { type: 'object', properties: { name: { type: 'string', description: '技能名' } }, required: ['name'] },
      'skill_read(name)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.name) return ToolResult.error('缺少技能名 name');
      const content = knowledge.readSkill(p.name);
      if (content === null) {
        recordSkillUsage(p.name, false);
        return ToolResult.error('技能不存在: ' + p.name);
      }
      const meta = knowledge.listSkills().find(s => s.name === p.name) || { name: p.name };
      // 使用埋点：skill_read 成功读取技能正文，视为一次成功使用
      recordSkillUsage(p.name, true);
      return ToolResult.success({ name: p.name, meta, content });
    } catch (e) {
      recordSkillUsage(p.name, false);
      return ToolResult.error(e.message);
    }
  }
}

// ========== skill_create ==========
class SkillCreateTool extends Tool {
  constructor() {
    super('skill_create', '创建技能（跨项目共享）',
      { type: 'object', properties: {
        name: { type: 'string', description: '技能名（建议 kebab-case，仅字母/数字/_/-）' },
        content: { type: 'string', description: '技能正文（Markdown）' },
        meta: { type: 'object', description: '可选元信息 { description, tags }' }
      }, required: ['name', 'content'] },
      'skill_create(name, content, meta)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.name || typeof p.content !== 'string') return ToolResult.error('缺少 name 或 content');
      const res = knowledge.createSkill(p.name, p.content, p.meta || {});
      if (!res.success) return ToolResult.error(res.error || '创建技能失败');
      return ToolResult.success({ name: res.name });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== skill_update ==========
class SkillUpdateTool extends Tool {
  constructor() {
    super('skill_update', '更新技能（正文/描述/标签）',
      { type: 'object', properties: {
        name: { type: 'string', description: '技能名' },
        content: { type: 'string', description: '新正文（可选）' },
        meta: { type: 'object', description: '可选元信息 { description, tags }' }
      }, required: ['name'] },
      'skill_update(name, content, meta)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.name) return ToolResult.error('缺少技能名 name');
      const res = knowledge.updateSkill(p.name, typeof p.content === 'string' ? p.content : undefined, p.meta);
      if (!res.success) return ToolResult.error(res.error || '更新技能失败');
      return ToolResult.success({ name: p.name });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== skill_delete ==========
class SkillDeleteTool extends Tool {
  constructor() {
    super('skill_delete', '删除技能（不可恢复）',
      { type: 'object', properties: { name: { type: 'string', description: '技能名' } }, required: ['name'] },
      'skill_delete(name)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.name) return ToolResult.error('缺少技能名 name');
      const res = knowledge.deleteSkill(p.name);
      if (!res.success) return ToolResult.error(res.error || '删除技能失败');
      return ToolResult.success({ name: p.name, deleted: true });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== skill_enable ==========
class SkillEnableTool extends Tool {
  constructor() {
    super('skill_enable', '在本项目启用某个技能',
      { type: 'object', properties: { name: { type: 'string', description: '技能名' } }, required: ['name'] },
      'skill_enable(name)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.name) return ToolResult.error('缺少技能名 name');
      const dir = currentProjectDir(p);
      if (!dir) return ToolResult.error('未找到当前项目目录，请先初始化项目');
      const res = knowledge.enableSkill(dir, p.name);
      if (!res.success) return ToolResult.error(res.error || '启用失败');
      return ToolResult.success({ name: p.name, projectDir: dir, already: !!res.already });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== skill_disable ==========
class SkillDisableTool extends Tool {
  constructor() {
    super('skill_disable', '在本项目禁用某个技能',
      { type: 'object', properties: { name: { type: 'string', description: '技能名' } }, required: ['name'] },
      'skill_disable(name)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.name) return ToolResult.error('缺少技能名 name');
      const dir = currentProjectDir(p);
      if (!dir) return ToolResult.error('未找到当前项目目录，请先初始化项目');
      const res = knowledge.disableSkill(dir, p.name);
      if (!res.success) return ToolResult.error(res.error || '禁用失败');
      return ToolResult.success({ name: p.name, projectDir: dir, already: !!res.already });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== skill_version_list ==========
class SkillVersionListTool extends Tool {
  constructor() {
    super('skill_version_list', '列出某技能的历史版本（快照）',
      { type: 'object', properties: { name: { type: 'string', description: '技能名' } }, required: ['name'] },
      'skill_version_list(name)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.name) return ToolResult.error('缺少技能名 name');
      const versions = knowledge.listSkillVersions(p.name);
      const active = versions.find(v => v.active) || null;
      return ToolResult.success({ name: p.name, total: versions.length, activeVersionId: active ? active.version : null, versions });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== skill_version_restore ==========
class SkillVersionRestoreTool extends Tool {
  constructor() {
    super('skill_version_restore', '回退技能到指定历史版本（快照）',
      { type: 'object', properties: {
        name: { type: 'string', description: '技能名' },
        version: { type: 'string', description: '版本 id（来自 skill_version_list）' }
      }, required: ['name', 'version'] },
      'skill_version_restore(name, version)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.name) return ToolResult.error('缺少技能名 name');
      if (!p.version) return ToolResult.error('缺少版本号 version');
      const res = knowledge.restoreSkillVersion(p.name, String(p.version));
      if (!res.success) return ToolResult.error(res.error || '回退技能失败');
      return ToolResult.success({ name: p.name, version: res.version, restored: true });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== preference_read ==========
class PreferenceReadTool extends Tool {
  constructor() {
    super('preference_read', '读取全局偏好（跨项目生效）',
      { type: 'object', properties: {} },
      'preference_read()');
  }
  getPromptSection() { return null; }
  async execute() {
    try {
      const content = knowledge.readPreferences();
      return ToolResult.success({ content });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== preference_append ==========
class PreferenceAppendTool extends Tool {
  constructor() {
    super('preference_append', '追加一条全局偏好（跨项目生效）',
      { type: 'object', properties: { text: { type: 'string', description: '偏好内容' } }, required: ['text'] },
      'preference_append(text)');
  }
  getPromptSection() { return null; }
  async execute(p) {
    try {
      if (!p || !p.text) return ToolResult.error('缺少偏好内容 text');
      const ok = knowledge.appendPreference(p.text);
      if (!ok) return ToolResult.error('追加偏好失败');
      return ToolResult.success({ appended: true });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

module.exports = {
  SkillListTool,
  SkillListEnabledTool,
  SkillReadTool,
  SkillCreateTool,
  SkillUpdateTool,
  SkillDeleteTool,
  SkillEnableTool,
  SkillDisableTool,
  SkillVersionListTool,
  SkillVersionRestoreTool,
  PreferenceReadTool,
  PreferenceAppendTool,
};
