/**
 * preload 可识别的工具名称集合
 * 替代原 preload.js 内联的 UnifiedToolManager：preload 只负责校验 AI 回复中的
 * toolName 是否存在（原实现仅使用 tools.has()/keys()），实际执行由主进程工具
 * 注册表（tools/index.js）完成。列表与顺序保持与原内联注册表一致。
 */
const TOOL_NAMES = [
  'file_write',
  'write',
  'file_read',
  'read',
  'read_lines',
  'file_edit',
  'edit',
  'file_glob',
  'glob',
  'file_grep',
  'grep',
  'todo_write',
  'bash',
  'pwsh',
  'mysql',
  'web_fetch',
  'open_browser_window',
  'open_shardx_browser',
  'read_shardx_page',
  'close_shardx_browser',
  'inject_js',
  'mcp_list_servers',
  'mcp_get_tools',
  'watchdog_heartbeat',
  'watchdog_busy',
  'watchdog_clear_busy',
  'watchdog_status',
  // 技能库
  'skill_list', 'skill_list_enabled', 'skill_read', 'skill_create', 'skill_update',
  'skill_delete', 'skill_enable', 'skill_disable', 'skill_version_list', 'skill_version_restore', 'preference_read', 'preference_append',
  // 教训
  'lesson_record', 'lesson_list', 'lesson_delete', 'lesson_search',
  // 观察日志
  'observation_add', 'observation_list', 'observation_merge',
  // 团队协作
  'team_list_workers', 'team_get_workers_status', 'team_dispatch_task', 'team_dispatch_batch',
  'team_get_progress', 'team_cancel_task', 'team_get_task_status', 'team_create_window',
  'team_read_inbox', 'team_reply_to_worker', 'team_show_dispatch_ui',
  'team_plan_create', 'team_plan_status', 'team_plan_clear',
  // 自工程化
  'auto_trace_list', 'auto_trace_get', 'auto_retrospect',
  'auto_skill_forge', 'auto_skill_forge_commit', 'auto_skill_stats',
  'auto_skill_archive_pass', 'auto_skill_record_usage',
  'auto_meta_record', 'auto_meta_analyze', 'auto_meta_version', 'auto_meta_bump',
  // 自驱循环
  'auto_goal_create', 'auto_goal_list', 'auto_goal_status', 'auto_goal_round', 'auto_goal_abort',
  // 文件检查点 / 回滚
  'checkpoint_list', 'checkpoint_restore',
];

/** 判断工具名是否存在（原 toolManager.tools.has(name)） */
function hasTool(name) {
  return TOOL_NAMES.includes(name);
}

/** 工具名列表字符串（原 Array.from(toolManager.tools.keys()).join(', ')） */
function toolNamesList() {
  return TOOL_NAMES.join(', ');
}

module.exports = { TOOL_NAMES, hasTool, toolNamesList };
