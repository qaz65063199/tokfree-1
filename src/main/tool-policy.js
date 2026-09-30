/**
 * 工具策略核心（Plan/Act 模式 + 危险操作判定）
 *
 * - Plan 模式：只读，写/执行工具被 block
 * - Act 模式：正常执行；危险操作（危险命令 / file_delete）按 confirmDangerous 决定是否 confirm
 *
 * 持久化到 userData/tool-policy.json。
 *
 * 数据结构（新模型：全局默认 + 标签覆盖）：
 *   {
 *     "__global__":     { "mode": "plan|act", "confirmDangerous": true },  // 全局默认（设置面板写这里，影响所有标签）
 *     "<profileId>":    { "mode": "plan|act", "confirmDangerous": true }   // 单标签覆盖（可选，逐字段覆盖全局）
 *   }
 * 回退顺序：某 profileId 的字段存在 → 用它；否则回退 __global__ 同字段；再回退 DEFAULT_*。
 * 向后兼容：老数据（只有 profileId 条目、无 __global__）仍按原语义工作。
 * 默认：mode='act'（不改变现有行为），confirmDangerous=true
 *
 * 存储风格参考 src/main/team/mode.js，损坏容错参考 src/main/knowledge.js。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { isDangerous } = require('./dangerous-commands');

const DEFAULT_MODE = 'act';
const DEFAULT_CONFIRM_DANGEROUS = true;

// 全局默认条目的存储 key（设置面板写入此处，影响所有未单独覆盖的标签）
const GLOBAL_KEY = '__global__';

// 工具分类清单（来自设计文档 P1-5）
const READ_TOOLS = [
  'read', 'file_read', 'read_lines', 'glob', 'file_glob', 'grep', 'file_grep',
  'web_fetch', 'mysql', 'mcp_call', 'mcp_list_servers', 'mcp_get_tools',
  'skill_list', 'skill_list_enabled', 'skill_read', 'preference_read',
  'lesson_list', 'lesson_search', 'todo_write', 'watchdog_*', 'team_get_*',
  'auto_trace_list', 'auto_trace_get', 'auto_retrospect', 'auto_skill_forge', 'auto_skill_stats',
  'auto_meta_analyze', 'auto_meta_version',
  'auto_goal_list', 'auto_goal_status',
  'team_list_workers', 'team_get_workers_status', 'team_read_inbox',
  'team_get_progress', 'team_get_task_status', 'team_plan_status',
];
const WRITE_TOOLS = [
  'write', 'file_write', 'edit', 'file_edit', 'file_delete', 'skill_create',
  'skill_update', 'skill_delete', 'skill_enable', 'skill_disable',
  'preference_append', 'lesson_record', 'lesson_delete', 'team_dispatch_task',
  'team_dispatch_batch', 'team_cancel_task', 'team_reply_to_worker', 'team_create_window',
  'team_plan_create', 'team_plan_clear',
  'auto_skill_forge_commit', 'auto_skill_archive_pass', 'auto_skill_record_usage',
  'auto_meta_record', 'auto_meta_bump',
  'auto_goal_create', 'auto_goal_round', 'auto_goal_abort',
];
const EXEC_TOOLS = [
  'bash', '__bash', 'pwsh', 'inject_js', 'human_move', 'human_click',
  'human_type', 'human_scroll', 'open_browser_window',
];

let cache = null; // { [profileId|GLOBAL_KEY]: { mode, confirmDangerous } }

function getConfigFile() {
  return path.join(app.getPath('userData'), 'tool-policy.json');
}

/** 把损坏文件改名备份，避免静默覆盖造成"数据丢失"错觉 */
function backupCorruptFile(file, reason) {
  try {
    if (!fs.existsSync(file)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(file, file + '.corrupt-' + stamp);
    console.error('[ToolPolicy] 文件损坏已备份(' + reason + '):', file);
  } catch (e) {
    console.error('[ToolPolicy] 备份损坏文件失败:', e.message);
  }
}

/** 读取整份配置 */
function loadAll() {
  if (cache) return cache;
  try {
    const f = getConfigFile();
    if (fs.existsSync(f)) {
      const obj = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        cache = obj;
        return cache;
      }
      backupCorruptFile(f, '结构非法');
    }
  } catch (err) {
    console.error('[ToolPolicy] 读取策略配置失败:', err.message);
    backupCorruptFile(getConfigFile(), 'JSON 解析失败');
  }
  // 不缓存失败结果
  return {};
}

/** 写回整份配置 */
function saveAll(obj) {
  cache = obj;
  try {
    fs.writeFileSync(getConfigFile(), JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    console.error('[ToolPolicy] 写入策略配置失败:', err.message);
  }
}

/**
 * 读取某窗口的策略（全局默认 + 标签覆盖合并）
 * 回退顺序：profileId 覆盖字段 → __global__ 字段 → DEFAULT_*
 * @param {string} [profileId]
 * @returns {{mode:'plan'|'act', confirmDangerous:boolean}}
 */
function getPolicy(profileId) {
  const all = loadAll();
  const entry = profileId ? all[profileId] : null;
  const global = all[GLOBAL_KEY] && typeof all[GLOBAL_KEY] === 'object' ? all[GLOBAL_KEY] : null;

  // mode：profile 覆盖优先 → 全局默认 → DEFAULT_MODE
  let mode;
  if (entry && (entry.mode === 'plan' || entry.mode === 'act')) {
    mode = entry.mode;
  } else if (global && (global.mode === 'plan' || global.mode === 'act')) {
    mode = global.mode;
  } else {
    mode = DEFAULT_MODE;
  }

  // confirmDangerous：profile 覆盖优先 → 全局默认 → DEFAULT_CONFIRM_DANGEROUS
  let confirmDangerous;
  if (entry && typeof entry.confirmDangerous === 'boolean') {
    confirmDangerous = entry.confirmDangerous;
  } else if (global && typeof global.confirmDangerous === 'boolean') {
    confirmDangerous = global.confirmDangerous;
  } else {
    confirmDangerous = DEFAULT_CONFIRM_DANGEROUS;
  }

  return { mode, confirmDangerous };
}

function ensureEntry(profileId) {
  const all = loadAll();
  if (!profileId) return { all, entry: null };
  if (!all[profileId] || typeof all[profileId] !== 'object') {
    all[profileId] = { mode: DEFAULT_MODE, confirmDangerous: DEFAULT_CONFIRM_DANGEROUS };
  }
  return { all, entry: all[profileId] };
}

/** 确保 __global__ 条目存在并返回 */
function ensureGlobalEntry() {
  const all = loadAll();
  if (!all[GLOBAL_KEY] || typeof all[GLOBAL_KEY] !== 'object') {
    all[GLOBAL_KEY] = { mode: DEFAULT_MODE, confirmDangerous: DEFAULT_CONFIRM_DANGEROUS };
  }
  return { all, entry: all[GLOBAL_KEY] };
}

/**
 * 设置某窗口模式
 * @param {'plan'|'act'} mode
 * @param {string} [profileId]
 * @returns {'plan'|'act'} 新 mode
 */
function setMode(mode, profileId) {
  const m = mode === 'plan' ? 'plan' : 'act';
  const { all, entry } = ensureEntry(profileId);
  if (entry) {
    entry.mode = m;
    saveAll(all);
    console.log('[ToolPolicy] 模式已保存 profile=' + profileId + ' mode=' + m);
  }
  return m;
}

/**
 * 设置某窗口"信任模式"（危险操作是否免确认）
 * @param {boolean} flag true=免确认
 * @param {string} [profileId]
 * @returns {boolean} 新 confirmDangerous 值
 */
function setConfirmDangerous(flag, profileId) {
  const b = !!flag;
  const { all, entry } = ensureEntry(profileId);
  if (entry) {
    entry.confirmDangerous = b;
    saveAll(all);
    console.log('[ToolPolicy] 信任模式已保存 profile=' + profileId + ' confirmDangerous=' + b);
  }
  return b;
}

/**
 * 设置全局"信任模式"（危险操作是否免确认）—— 写入 __global__，影响所有未单独覆盖的标签
 * @param {boolean} flag true=免确认
 * @returns {boolean} 新 confirmDangerous 值
 */
function setGlobalTrust(flag) {
  const b = !!flag;
  const { all, entry } = ensureGlobalEntry();
  entry.confirmDangerous = b;
  saveAll(all);
  console.log('[ToolPolicy] 全局信任模式已保存 confirmDangerous=' + b);
  return b;
}

/**
 * 设置全局工具模式（plan/act）—— 写入 __global__，影响所有未单独覆盖的标签
 * @param {'plan'|'act'} mode
 * @returns {'plan'|'act'} 新 mode
 */
function setGlobalMode(mode) {
  const m = mode === 'plan' ? 'plan' : 'act';
  const { all, entry } = ensureGlobalEntry();
  entry.mode = m;
  saveAll(all);
  console.log('[ToolPolicy] 全局工具模式已保存 mode=' + m);
  return m;
}

/**
 * 工具分类
 * @param {string} toolName
 * @returns {'read'|'write'|'exec'} 未列出的默认 'write'
 */
function classifyTool(toolName) {
  const name = String(toolName);
  if (EXEC_TOOLS.includes(name)) return 'exec';
  if (READ_TOOLS.includes(name)) return 'read';
  if (name.startsWith('watchdog_') || name.startsWith('team_get_')) return 'read';
  if (WRITE_TOOLS.includes(name)) return 'write';
  return 'write';
}

/** bash/pwsh 类命令工具 */
function isExecCommand(toolName) {
  return toolName === 'bash' || toolName === '__bash' || toolName === 'pwsh';
}

/** 从 params 里提取命令字符串 */
function extractCommand(params) {
  if (!params || typeof params !== 'object') return '';
  const cmd = params.command || params.cmd || '';
  return typeof cmd === 'string' ? cmd : '';
}

/**
 * 策略判定
 * @param {string} profileId
 * @param {string} toolName
 * @param {object} [params]
 * @returns {{action:'allow'|'block'|'confirm', reason:string, mode:'plan'|'act'}}
 */
function checkPolicy(profileId, toolName, params) {
  const policy = getPolicy(profileId);
  const { mode, confirmDangerous } = policy;

  if (mode === 'plan') {
    const cls = classifyTool(toolName);
    if (cls === 'read') {
      return { action: 'allow', reason: '', mode };
    }
    return { action: 'block', reason: 'Plan 模式只读，请先切换到 Act 模式', mode };
  }

  // Act 模式：exec 命令先查命令策略（allow/confirm/deny），未命中则回退内置黑名单
  if (isExecCommand(toolName)) {
    const cmd = extractCommand(params);
    let ruleDecision = null;
    try {
      const commandPolicy = require('./command-policy');
      ruleDecision = commandPolicy.evaluateCommandPolicy(cmd);
    } catch (_) {
      ruleDecision = null; // 策略模块不可用时回退黑名单
    }
    if (ruleDecision && ruleDecision.matched) {
      if (ruleDecision.action === 'deny') {
        return {
          action: 'block',
          reason: '命令被策略禁止（deny 规则）：' + (ruleDecision.note || ''),
          mode,
        };
      }
      if (ruleDecision.action === 'allow') {
        return { action: 'allow', reason: '', mode };
      }
      // confirm
      if (confirmDangerous) {
        return { action: 'confirm', reason: '命令需确认（confirm 规则）：' + (ruleDecision.note || ''), mode };
      }
      return { action: 'allow', reason: '', mode };
    }
    // 未命中用户规则 → 回退内置黑名单（保持向后兼容）
    if (isDangerous(cmd)) {
      if (confirmDangerous) {
        return { action: 'confirm', reason: '危险命令需要确认', mode };
      }
      return { action: 'allow', reason: '', mode };
    }
  }

  if (toolName === 'file_delete') {
    if (confirmDangerous) {
      return { action: 'confirm', reason: '删除文件需要确认', mode };
    }
    return { action: 'allow', reason: '', mode };
  }

  return { action: 'allow', reason: '', mode };
}

/** 仅供测试重置内存缓存 */
function _resetCache() {
  cache = null;
}

module.exports = {
  getPolicy,
  setMode,
  setConfirmDangerous,
  setGlobalTrust,
  setGlobalMode,
  GLOBAL_KEY,
  checkPolicy,
  classifyTool,
  DEFAULT_MODE,
  DEFAULT_CONFIRM_DANGEROUS,
  READ_TOOLS,
  WRITE_TOOLS,
  EXEC_TOOLS,
  _resetCache,
};
