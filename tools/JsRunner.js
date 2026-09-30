/**
 * JsRunner - 在受限的 Node vm 沙箱中执行 AI 生成的 JavaScript 工具代码
 *
 * 设计要点：
 * - 通过 vm.createContext 创建沙箱，禁用字符串代码生成（eval / Function 构造器均被禁用）
 * - AI 代码无法访问 require / process / global 等 Node 能力，只能使用注入的工具函数
 * - 工具函数（readFile / readFileWithLines / writeFile / editFile / glob / grep / bash / deleteFile / log）
 *   通过唯一的 __hostBridge 桥接函数回到主进程执行，宿主函数从不向沙箱抛出宿主对象
 * - 每个工具调用都带执行截止时间检查，防止死循环；整体运行有 60 秒超时
 */

const vm = require('vm');
const { exec } = require('child_process');
const path = require('path');
const { DANGEROUS_CMDS } = require('./BashTool');
const { decodeOutput, normalizeCommand } = require('./decodeOutput');
const workerActivity = require('../src/main/worker-activity');
const trace = require('../src/main/team/trace');
const { logger } = require('../src/core/logger');

// 同步执行超时（vm timeout，覆盖无 await 的死循环）
const SYNC_TIMEOUT = 30 * 1000;
// 整体运行截止时间（配合宿主桥接检查，覆盖 async 死循环）
const RUN_DEADLINE = 60 * 1000;
// 输出长度上限
const OUTPUT_LIMIT = 20000;

/**
 * 沙箱初始化脚本：在沙箱上下文内定义所有工具函数
 * 注意：该脚本运行在沙箱 realm 内，其抛出的 Error 也是沙箱 realm 对象，无逃逸风险
 */
const BOOTSTRAP = [
"'use strict';",
"(function () {",
"  globalThis.__logs = [];",
"",
"  function __stringify(value) {",
"    if (typeof value === 'string') return value;",
"    try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }",
"  }",
"",
"  globalThis.log = function () {",
"    var parts = [];",
"    for (var i = 0; i < arguments.length; i++) parts.push(__stringify(arguments[i]));",
"    globalThis.__logs.push(parts.join(' '));",
"  };",
"",
"  // ===== sleep / setTimeout 支持（借鉴 Cuckoo Code 0.7.0）=====",
"  globalThis.setTimeout = function (fn, ms) {",
"    var args = Array.prototype.slice.call(arguments, 2);",
"    return __hostSetTimeout(function () { if (typeof fn === 'function') fn.apply(null, args); }, Math.max(0, Number(ms) || 0));",
"  };",
"  globalThis.clearTimeout = function (id) {",
"    __hostClearTimeout(id);",
"  };",
"  globalThis.sleep = function (ms) {",
"    var n = Math.max(0, Number(ms) || 0);",
"    if (n > 60000) n = 60000;",
"    return new Promise(function (r) { __hostSetTimeout(r, n); });",
"  };",
"",
"  globalThis.projectDir = __projectDir;",
"",
"  async function __call(name, args) {",
"    var resText = await __hostBridge(name, JSON.stringify(args == null ? {} : args));",
"    var res;",
"    try { res = JSON.parse(resText); } catch (e) { throw new Error('工具结果解析失败: ' + e.message); }",
"    if (!res || res.success !== true) {",
"      throw new Error((res && res.error) || ('工具 ' + name + ' 执行失败'));",
"    }",
"    return res.data;",
"  }",
"",
"  globalThis.readFile = async function (filePath, encoding) {",
"    return await __call('file_read', { file_path: filePath, encoding: encoding || 'utf-8' });",
"  };",
"  globalThis.readFileWithLines = async function (filePath, encoding) {",
"    return await __call('file_read', { file_path: filePath, encoding: encoding || 'utf-8', line_numbers: true });",
"  };",
"  globalThis.read = async function (filePath, options) {",
"    options = options || {};",
"    return await __call('read', {",
"      file_path: filePath,",
"      offset: options.offset,",
"      limit: options.limit",
"    });",
"  };",
"  globalThis.readLines = async function (filePath, options) {",
"    options = options || {};",
"    return await __call('read_lines', {",
"      file_path: filePath,",
"      offset: options.offset,",
"      limit: options.limit",
"    });",
"  };",
"  globalThis.write = async function (filePath, content) {",
"    return await __call('write', { file_path: filePath, content: content });",
"  };",
"  globalThis.writeFile = async function (filePath, content, encoding) {",
"    return await __call('file_write', { file_path: filePath, content: content, encoding: encoding || 'utf-8' });",
"  };",
"  globalThis.edit = async function (filePath, oldString, newString, replaceAll, dryRun) {",
"    return await __call('edit', { file_path: filePath, old_string: oldString, new_string: newString, replaceAll: replaceAll === true, dryRun: dryRun === true });",
"  };",
"  globalThis.editFile = async function (filePath, oldString, newString, replaceAll) {",
"    return await __call('file_edit', { file_path: filePath, old_string: oldString, new_string: newString, replace_all: replaceAll === true });",
"  };",
"  globalThis.glob = async function (pattern, searchPath) {",
"    return await __call('glob', { pattern: pattern, path: searchPath });",
"  };",
"  globalThis.grep = async function (pattern, options) {",
"    options = options || {};",
"    return await __call('grep', {",
"      pattern: pattern,",
"      path: options.path,",
"      include: options.include",
"    });",
"  };",
"  globalThis.todoWrite = async function (todos) {",
"    return await __call('todo_write', { todos: todos });",
"  };",
"  globalThis.bash = async function (command, options) {",
"    options = options || {};",
"    return await __call('__bash', {",
"      command: command,",
"      description: options.description,",
"      workdir: options.workdir || options.cwd,",
"      timeoutMs: options.timeoutMs || options.timeout",
"    });",
"  };",
"  globalThis.pwsh = async function (command, options) {",
"    options = options || {};",
"    return await __call('pwsh', {",
"      command: command,",
"      description: options.description,",
"      workdir: options.workdir || options.cwd,",
"      timeoutMs: options.timeoutMs || options.timeout",
"    });",
"  };",
"  globalThis.deleteFile = async function (filePath) {",
"    return await __call('file_delete', { file_path: filePath });",
"  };",
"  globalThis.webFetch = async function (url) {",
"    return await __call('web_fetch', { url: url });",
"  };",
"  globalThis.mysql = async function (options) {",
"    options = options || {};",
"    return await __call('mysql', options);",
"  };",
"  globalThis.mcpCall = async function (server, tool, args) {",
"    return await __call('mcp_call', { server: server, tool: tool, args: args || {} });",
"  };",
  "  globalThis.mcpListServers = async function () {",
  "    return await __call('mcp_list_servers', {});",
  "  };",
  "  globalThis.mcpGetTools = async function (serverName) {",
  "    return await __call('mcp_get_tools', { server: serverName });",
  "  };",
  "  globalThis.team_list_workers = async function () {",
  "    return await __call('team_list_workers', {});",
  "  };",
  "  globalThis.team_get_workers_status = async function () {",
  "    return await __call('team_get_workers_status', {});",
  "  };",
  "  globalThis.team_dispatch_task = async function (profileId, prompt, projectDir, module, mode, sessionId) {",
  "    return await __call('team_dispatch_task', { profileId: profileId, prompt: prompt, projectDir: projectDir, module: module, mode: mode, sessionId: sessionId });",
  "  };",
  "  globalThis.team_dispatch_batch = async function (tasks) {",
  "    return await __call('team_dispatch_batch', { tasks: tasks });",
  "  };",
  "  globalThis.team_get_progress = async function () {",
  "    return await __call('team_get_progress', {});",
  "  };",
  "  globalThis.team_cancel_task = async function (taskId) {",
  "    return await __call('team_cancel_task', { taskId: taskId });",
  "  };",
  "  globalThis.team_get_task_status = async function (taskId) {",
  "    return await __call('team_get_task_status', { taskId: taskId });",
  "  };",
  "  globalThis.team_create_window = async function (providerId, name) {",
  "    return await __call('team_create_window', { providerId: providerId, name: name });",
  "  };",
  "  globalThis.team_read_inbox = async function (taskId) {",
  "    return await __call('team_read_inbox', { taskId: taskId });",
  "  };",
  "  globalThis.team_reply_to_worker = async function (taskId, message) {",
  "    return await __call('team_reply_to_worker', { taskId: taskId, message: message });",
  "  };",
  "  globalThis.team_show_dispatch_ui = async function () {",
  "    return await __call('team_show_dispatch_ui', {});",
  "  };",
  "  globalThis.team_plan_create = async function (goal, modules) {",
  "    return await __call('team_plan_create', { goal: goal, modules: modules });",
  "  };",
  "  globalThis.team_plan_status = async function () {",
  "    return await __call('team_plan_status', {});",
  "  };",
  "  globalThis.team_plan_clear = async function () {",
  "    return await __call('team_plan_clear', {});",
  "  };",
  "  globalThis.watchdog_heartbeat = async function () {",
  "    return await __call('watchdog_heartbeat', {});",
  "  };",
  "  globalThis.watchdog_busy = async function (note, secs) {",
  "    return await __call('watchdog_busy', { note: note, secs: secs });",
  "  };",
  "  globalThis.watchdog_clear_busy = async function () {",
  "    return await __call('watchdog_clear_busy', {});",
  "  };",
  "  globalThis.watchdog_status = async function () {",
  "    return await __call('watchdog_status', {});",
  "  };",
"  globalThis.skill_list = async function () {",
"    return await __call('skill_list', {});",
"  };",
"  globalThis.skill_list_enabled = async function () {",
"    return await __call('skill_list_enabled', {});",
"  };",
"  globalThis.skill_read = async function (name) {",
"    return await __call('skill_read', { name: name });",
"  };",
"  globalThis.skill_create = async function (name, content, meta) {",
"    return await __call('skill_create', { name: name, content: content, meta: meta });",
"  };",
"  globalThis.skill_update = async function (name, content, meta) {",
"    return await __call('skill_update', { name: name, content: content, meta: meta });",
"  };",
"  globalThis.skill_delete = async function (name) {",
"    return await __call('skill_delete', { name: name });",
"  };",
"  globalThis.skill_enable = async function (name) {",
"    return await __call('skill_enable', { name: name });",
"  };",
"  globalThis.skill_disable = async function (name) {",
"    return await __call('skill_disable', { name: name });",
"  };",
"  globalThis.skill_version_list = async function (name) {",
"    return await __call('skill_version_list', { name: name });",
"  };",
"  globalThis.skill_version_restore = async function (name, version) {",
"    return await __call('skill_version_restore', { name: name, version: version });",
"  };",
"  globalThis.preference_read = async function () {",
"    return await __call('preference_read', {});",
"  };",
"  globalThis.preference_append = async function (text) {",
"    return await __call('preference_append', { text: text });",
"  };",
"  globalThis.lesson_record = async function (lesson, context, tags, scope) {",
"    return await __call('lesson_record', { lesson: lesson, context: context, tags: tags, scope: scope });",
"  };",
"  globalThis.lesson_list = async function () {",
"    return await __call('lesson_list', {});",
"  };",
"  globalThis.lesson_delete = async function (id) {",
"    return await __call('lesson_delete', { id: id });",
"  };",
"  globalThis.lesson_search = async function (keywords, limit) {",
"    return await __call('lesson_search', { keywords: keywords, limit: limit });",
"  };",
  "  globalThis.observation_add = async function (category, summary) {",
  "    return await __call('observation_add', { category: category, summary: summary });",
  "  };",
  "  globalThis.observation_list = async function (limit) {",
  "    return await __call('observation_list', { limit: limit });",
  "  };",
  "  globalThis.observation_merge = async function (summary) {",
  "    return await __call('observation_merge', { summary: summary });",
  "  };",
  "  // ===== 自工程化工具（Agent 自写/自修复/自迭代 Skill）=====",
  "  globalThis.auto_trace_list = async function (limit) {",
  "    return await __call('auto_trace_list', { limit: limit });",
  "  };",
  "  globalThis.auto_trace_get = async function (taskId) {",
  "    return await __call('auto_trace_get', { taskId: taskId });",
  "  };",
  "  globalThis.auto_retrospect = async function (taskId) {",
  "    return await __call('auto_retrospect', { taskId: taskId });",
  "  };",
  "  globalThis.auto_skill_forge = async function (analysis) {",
  "    return await __call('auto_skill_forge', { analysis: analysis });",
  "  };",
  "  globalThis.auto_skill_forge_commit = async function (draft) {",
  "    return await __call('auto_skill_forge_commit', { draft: draft });",
  "  };",
  "  globalThis.auto_skill_stats = async function () {",
  "    return await __call('auto_skill_stats', {});",
  "  };",
  "  globalThis.auto_skill_archive_pass = async function () {",
  "    return await __call('auto_skill_archive_pass', {});",
  "  };",
  "  globalThis.auto_skill_record_usage = async function (name, success, durationMs) {",
  "    return await __call('auto_skill_record_usage', { name: name, success: success, durationMs: durationMs });",
  "  };",
  "  globalThis.auto_meta_record = async function (activity, success, usefulScore, taskId, note) {",
  "    return await __call('auto_meta_record', { activity: activity, success: success, usefulScore: usefulScore, taskId: taskId, note: note });",
  "  };",
  "  globalThis.auto_meta_analyze = async function () {",
  "    return await __call('auto_meta_analyze', {});",
  "  };",
  "  globalThis.auto_meta_version = async function () {",
  "    return await __call('auto_meta_version', {});",
  "  };",
  "  globalThis.auto_meta_bump = async function (reason, patchMethods) {",
  "    return await __call('auto_meta_bump', { reason: reason, patchMethods: patchMethods });",
  "  };",
  "  // ===== 自驱循环（无人干预持续进化）=====",
  "  globalThis.auto_goal_create = async function (title, successCriteria, maxRounds, maxMs, testQueries) {",
  "    return await __call('auto_goal_create', { title: title, successCriteria: successCriteria, maxRounds: maxRounds, maxMs: maxMs, testQueries: testQueries });",
  "  };",
  "  globalThis.auto_goal_list = async function (status) {",
  "    return await __call('auto_goal_list', { status: status });",
  "  };",
  "  globalThis.auto_goal_status = async function (goalId) {",
  "    return await __call('auto_goal_status', { goalId: goalId });",
  "  };",
  "  globalThis.auto_goal_round = async function (goalId, criteriaResults, aiScore, actions, note) {",
  "    return await __call('auto_goal_round', { goalId: goalId, criteriaResults: criteriaResults, aiScore: aiScore, actions: actions, note: note });",
  "  };",
  "  globalThis.auto_goal_abort = async function (goalId, reason) {",
  "    return await __call('auto_goal_abort', { goalId: goalId, reason: reason });",
  "  };",
  "  globalThis.checkpoint_list = async function (limit) {",
  "    return await __call('checkpoint_list', { limit: limit });",
  "  };",
  "  globalThis.checkpoint_restore = async function (id) {",
  "    return await __call('checkpoint_restore', { id: id });",
  "  };",
"  globalThis.openBrowserWindow = async function (url, options) {",
"    options = options || {};",
"    return await __call('open_browser_window', {",
"      url: url,",
"      id: options.id,",
"      width: options.width,",
"      height: options.height,",
"      partition: options.partition",
"    });",
"  };",
"  globalThis.open_shardx_browser = async function (url, options) {",
"    options = options || {};",
"    return await __call('open_shardx_browser', {",
"      url: url,",
"      id: options.id,",
"      headless: options.headless",
"    });",
"  };",
"  globalThis.read_shardx_page = async function (profile_id, options) {",
"    options = options || {};",
"    return await __call('read_shardx_page', {",
"      profile_id: profile_id,",
"      selector: options.selector,",
"      mode: options.mode",
"    });",
"  };",
"  globalThis.close_shardx_browser = async function (profile_id) {",
"    return await __call('close_shardx_browser', { profile_id: profile_id });",
"  };",
"  globalThis.injectJS = async function (windowId, code) {",
"    return await __call('inject_js', { windowId: windowId, code: code });",
  "  };",
  "  globalThis.human_move = async function (windowId, x, y, opts) {",
  "    return await __call('human_move', { windowId: windowId, x: x, y: y, opts: opts });",
  "  };",
  "  globalThis.human_click = async function (windowId, target, opts) {",
  "    return await __call('human_click', { windowId: windowId, target: target, opts: opts });",
  "  };",
  "  globalThis.human_type = async function (windowId, text, opts) {",
  "    return await __call('human_type', { windowId: windowId, text: text, opts: opts });",
  "  };",
  "  globalThis.human_scroll = async function (windowId, deltaY, opts) {",
  "    return await __call('human_scroll', { windowId: windowId, deltaY: deltaY, opts: opts });",
  "  };",
  "  globalThis.screenshot = async function (windowId) {",
  "    return await __call('screenshot', { windowId: windowId });",
  "  };",
  "  globalThis.attachFile = async function (filePath) {",
  "    return await __call('attach_file', { path: filePath });",
  "  };",
"",
"  if (!globalThis.projectDir) {",
  "  globalThis.log('[提示] 尚未初始化项目目录，相对路径将基于系统目录解析。可点击覆盖层“初始化项目”。');",
"  }",
"})();",
"",
].join('\n');

/**
 * 解析命令工作目录（相对路径基于项目目录）
 */
function resolveDir(dir, projectDir) {
  if (!dir) return projectDir || process.env.USERPROFILE || path.resolve('.');
  const normalized = String(dir).replace(/\//g, path.sep);
  if (path.isAbsolute(normalized)) return normalized;
  if (projectDir) return path.join(projectDir, normalized);
  return path.resolve(normalized);
}

/**
 * 执行 shell 命令（JS API 专用实现）
 * 与 JSON 工具的 bash 不同：非零退出码不视为失败，而是通过 exitCode/error 字段返回，
 * 让 AI 代码可以像普通 shell 一样判断结果。
 */
function runBash(args, projectDir) {
  const command = normalizeCommand(String(args.command || '').trim());
  if (!command) return Promise.resolve({ success: false, error: 'invalid command: expected a non-empty string' });
  if (DANGEROUS_CMDS.some((pattern) => pattern.test(command))) {
    return Promise.resolve({ success: false, error: '命令被安全策略拒绝（危险命令）: ' + command });
  }
  const timeout = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 30000;
  const cwd = resolveDir(args.workdir || args.cwd, projectDir);

  return new Promise((resolve) => {
    exec(command, { cwd, timeout, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'buffer' }, (error, stdout, stderr) => {
      const out = decodeOutput(stdout);
      const err = decodeOutput(stderr);

      // dsh 风格渲染：stdout + [stderr] 分节 + 状态标记
      let body = out;
      if (err && err.length > 0) {
        if (body.length > 0 && !body.endsWith('\n')) body += '\n';
        body += '[stderr]\n' + err;
      }
      if (body.length === 0) body = '(no output)';

      const markers = [];
      if (error) {
        if (error.killed) {
          markers.push('[timed out after ' + timeout + 'ms]');
        } else if (typeof error.code === 'number') {
          markers.push('[exit code: ' + error.code + ']');
        } else {
          markers.push('[exit code: 1]');
        }
      }

      if (markers.length > 0) {
        if (!body.endsWith('\n')) body += '\n';
        body += markers.join('\n');
      }

      // 非零退出也正常返回（success:true），模型看到标记自行判断
      resolve({ success: true, data: body });
    });
  });
}

/**
 * 安全的 JSON 序列化（处理循环引用等异常）
 */
function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (e) {
    try {
      return String(value);
    } catch (e2) {
      return '[无法序列化的返回值]';
    }
  }
}

class JsRunner {
  /**
   * @param {import('./ToolRegistry').ToolRegistry} registry 工具注册表
   */
  constructor(registry) {
    this.registry = registry;
  }

  /**
   * 执行 AI 生成的 JS 工具代码
   * @param {string} code - AI 生成的 JavaScript 代码（无需函数包裹，支持顶层 await）
   * @param {string|null} projectDir - 当前项目目录（相对路径基准）
   * @returns {Promise<{success: boolean, output?: string, error?: string}>}
   */
  async run(code, projectDir, callerProfileId) {
    if (!code || typeof code !== 'string' || !code.trim()) {
      return { success: false, error: '无效的 JS 代码' };
    }

    const startTime = Date.now();
    const deadlineMs = RUN_DEADLINE;

    // 唯一跨域桥接函数：AI 代码中的每个工具调用都通过它回到主进程执行。
    // 注意：该函数绝不向沙箱抛出宿主对象（错误一律包装成 { success:false, error } 结果），
    // 避免沙箱内出现宿主 realm 的 Error / Function 逃逸通道。
    const hostBridge = async (op, argsJson) => {
      if (Date.now() - startTime > deadlineMs) {
        return JSON.stringify({ success: false, error: 'JS 脚本执行超时（' + Math.round(deadlineMs / 1000) + ' 秒）' });
      }
      let args = {};
      try {
        args = JSON.parse(argsJson || '{}');
      } catch (e) {
        args = {};
      }

      // ===== 主大脑硬约束：多Agent+master 禁止写操作（物理隔离，非提醒） =====
      try {
        const rm = require('../src/main/team/role-manager');
        const r = rm.getRole(callerProfileId);
        if (r.role === 'master') {
          const WRITE_OPS = ['write', 'file_write', 'edit', 'file_edit', 'file_delete', 'delete', '__bash', 'bash'];
          if (WRITE_OPS.indexOf(op) !== -1) {
            const hasWorker = rm.getWorkersOf(callerProfileId).length > 0;
            if (hasWorker) {
              return JSON.stringify({ success: false, error: '[主大脑约束] 你是主大脑（多Agent模式），禁止亲自执行写操作(' + op + ')。请用 team_dispatch_task 派发给子Agent；只有只读操作(read/grep/glob)和 team_* 调度工具可用。' });
            }
          }
        }
      } catch (_) {}

      // ===== 策略拦截（Plan/Act 模式 + 危险操作确认） =====
      try {
        const policy = require('../src/main/tool-policy');
        const decision = policy.checkPolicy(callerProfileId, op, args);
        if (decision && decision.action === 'block') {
          return JSON.stringify({ success: false, error: '[策略阻止] ' + (decision.reason || '') });
        }
        if (decision && decision.action === 'confirm') {
          const confirm = require('../src/main/tool-confirm');
          const ok = await confirm.confirmViaRenderer(callerProfileId, op, args, decision.reason);
          if (!ok) {
            return JSON.stringify({ success: false, error: '[用户拒绝] ' + op + ' 已被用户拒绝执行' });
          }
        }
      } catch (e) {
        // 策略模块不可用时放行（不改变现有行为）
      }

      // ===== Hook: PreToolUse（可插拔扩展点，无配置时零开销） =====
      try {
        const hooks = require('../src/main/hooks');
        if (hooks.hasHooks('PreToolUse')) {
          const hr = await hooks.runHook('PreToolUse', {
            event: 'PreToolUse', tool: op, input: args, profileId: callerProfileId || null, projectDir: projectDir || null,
          });
          if (hr && hr.decision === 'deny') {
            return JSON.stringify({ success: false, error: '[Hook 阻止] ' + (hr.reason || '') });
          }
          if (hr && hr.decision === 'ask') {
            const confirm = require('../src/main/tool-confirm');
            const ok = await confirm.confirmViaRenderer(callerProfileId, op, args, hr.reason || 'Hook 请求确认');
            if (!ok) {
              return JSON.stringify({ success: false, error: '[Hook 拒绝] ' + op + ' 已被用户拒绝执行' });
            }
          }
          if (hr && hr.modifiedInput && typeof hr.modifiedInput === 'object') {
            Object.assign(args, hr.modifiedInput);
          }
        }
      } catch (e) {
        logger.error('[JsRunner] PreToolUse hook 异常，放行:', e && e.message ? e.message : String(e));
      }

      let result;
      const stepStart = Date.now();
      const traceKey = (callerProfileId || "shell");
      if (op === "__bash") {
        result = await runBash(args, projectDir);
      } else {
        const tool = this.registry.get(op);
        if (!tool) {
          result = { success: false, error: "未知工具: " + op };
        } else {
          try {
            result = await tool.execute(Object.assign({}, args, { projectDir, __callerProfileId: callerProfileId || null }));
          } catch (err) {
            result = { success: false, error: "工具 " + op + " 执行异常: " + (err.message || String(err)) };
          }
        }
      }
      if (result && result.success === true) {
        workerActivity.touch(callerProfileId);
      }
      try {
        const outStr = result && result.data !== undefined ? JSON.stringify(result.data) : "";
        trace.recordStep(traceKey, {
          tool: op,
          args: args,
          success: !!(result && result.success),
          error: result && !result.success ? (result.error || "") : "",
          durationMs: Date.now() - stepStart,
          outputSize: outStr ? outStr.length : 0,
          profileId: callerProfileId || "",
        });
      } catch (_) {}

      // ===== Hook: PostToolUse（可插拔扩展点，无配置时零开销） =====
      try {
        const hooks = require('../src/main/hooks');
        if (hooks.hasHooks('PostToolUse')) {
          const hr = await hooks.runHook('PostToolUse', {
            event: 'PostToolUse', tool: op, input: args, result, projectDir: projectDir || null,
          });
          if (hr && hr.additionalContext && result && typeof result === 'object') {
            if (typeof result.data === 'string') {
              result.data = result.data + '\n\n' + hr.additionalContext;
            } else {
              result.hookContext = hr.additionalContext;
            }
          }
        }
      } catch (e) {
        logger.error('[JsRunner] PostToolUse hook 异常:', e && e.message ? e.message : String(e));
      }

      return JSON.stringify(result);
    };

    // ========== 沙箱构建与加固 ==========
    const sandbox = {};
    // 沙箱内定时器桥接：由宿主 realm 托管，脚本结束时统一清理，避免泄漏
    const pendingTimers = new Set();
    const hostSetTimeout = (fn, ms) => {
      const delay = Math.max(0, Number(ms) || 0);
      const id = setTimeout(() => {
        pendingTimers.delete(id);
        try { fn(); } catch (e) { /* 回调异常不逃逸到宿主 */ }
      }, delay);
      pendingTimers.add(id);
      return id;
    };
    const hostClearTimeout = (id) => {
      if (id && pendingTimers.has(id)) {
        clearTimeout(id);
        pendingTimers.delete(id);
      }
    };
    Object.defineProperty(sandbox, '__hostBridge', {
      value: hostBridge, enumerable: true, writable: false, configurable: false,
    });
    Object.defineProperty(sandbox, '__hostSetTimeout', {
      value: hostSetTimeout, enumerable: true, writable: false, configurable: false,
    });
    Object.defineProperty(sandbox, '__hostClearTimeout', {
      value: hostClearTimeout, enumerable: true, writable: false, configurable: false,
    });
    Object.defineProperty(sandbox, '__projectDir', {
      value: projectDir || null, enumerable: true, writable: false, configurable: false,
    });
    // 截断沙箱对象与桥接函数的原型链，阻止经 constructor/__proto__ 逃逸到宿主 realm
    try { Object.setPrototypeOf(sandbox, null); } catch (e) { /* 尽力而为 */ }
    try { Object.setPrototypeOf(hostBridge, null); } catch (e) { /* 尽力而为 */ }

    let context;
    try {
      context = vm.createContext(sandbox, {
        codeGeneration: { strings: false, wasm: false },
        name: 'tokfree-js-sandbox',
      });
    } catch (err) {
      // 兜底：极少数环境中 null 原型沙箱不可用
      const fallback = {};
      fallback.__hostBridge = hostBridge;
      fallback.__hostSetTimeout = hostSetTimeout;
      fallback.__hostClearTimeout = hostClearTimeout;
      fallback.__projectDir = projectDir || null;
      context = vm.createContext(fallback, {
        codeGeneration: { strings: false, wasm: false },
        name: 'tokfree-js-sandbox',
      });
    }

    try {
      vm.runInContext(BOOTSTRAP, context, { filename: 'tokfree-js-api.js' });
    } catch (err) {
      return { success: false, error: '沙箱初始化失败: ' + (err.message || String(err)) };
    }

    // 包装为 async IIFE：支持顶层 await、return 返回值
    const script = new vm.Script('(async () => {\n' + code + '\n})()', { filename: 'tokfree-js-tool-script.js' });

    let settleTimer = null;
    try {
      const deadline = new Promise((_resolve, reject) => {
        settleTimer = setTimeout(
          () => reject(new Error('JS 脚本执行超时（' + Math.round(deadlineMs / 1000) + ' 秒）')),
          deadlineMs
        );
      });

      const ret = await Promise.race([script.runInContext(context, { timeout: SYNC_TIMEOUT }), deadline]);

      // 收集 log() 输出
      let logs = [];
      try {
        const logsJson = vm.runInContext('JSON.stringify(globalThis.__logs || [])', context);
        logs = JSON.parse(logsJson);
      } catch (e) { /* 忽略日志收集失败 */ }

      const parts = [];
      if (Array.isArray(logs) && logs.length > 0) {
        parts.push(logs.join('\n'));
      }
      if (ret !== undefined && ret !== null) {
        parts.push(typeof ret === 'string' ? ret : safeStringify(ret));
      }

      let output = parts.filter(Boolean).join('\n\n');
      if (output.length > OUTPUT_LIMIT) {
        output = output.slice(0, OUTPUT_LIMIT) + '\n...[输出过长已截断]...';
      }

      return { success: true, output: output || '(脚本执行完成，无输出)\n如需输出请使用 log() 方法' };
    } catch (err) {
      console.error('[JsRunner] 脚本执行失败:', err && err.stack ? err.stack : String(err));
      console.error('[JsRunner] [诊断] 失败代码(JSON转义): ' + JSON.stringify(code));
      return { success: false, error: err && err.message ? err.message : String(err) };
    } finally {
      if (settleTimer) clearTimeout(settleTimer);
      // 清理脚本遗留的定时器，避免宿主 realm 泄漏
      for (const id of pendingTimers) {
        try { clearTimeout(id); } catch (e) { /* 尽力而为 */ }
      }
      pendingTimers.clear();
    }
  }
}

module.exports = { JsRunner };

