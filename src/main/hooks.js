'use strict';
/**
 * Hooks 事件系统（借鉴 ZCode 的 Hook 协议）
 *
 * 给工具调用加可插拔扩展点，不改动现有安全逻辑（tool-policy/tool-confirm/
 * dangerous-commands/command-policy）。
 *
 * 配置来源：<baseDir>/hooks.json
 * 结构示例：
 *   {
 *     "PreToolUse":  [{ "matcher": "bash|pwsh", "command": "node /path/to/hook.js" }],
 *     "PostToolUse": [{ "matcher": "",        "command": "node /path/to/hook.js" }]
 *   }
 * matcher 是工具名正则（不填 / 空串 / "*" = 匹配全部工具）。
 *
 * Hook 协议（本地子进程）：
 *   - 把 payload 作为一行 JSON 写到子进程 stdin；
 *   - 退出码 0 = 放行（stdout 若含 JSON，可解析出 decision/additionalContext/modifiedInput）；
 *   - 退出码 2 = 阻断（reason 取自 stdout JSON / stdout 原文 / stderr）；
 *   - 其他退出码 = 失败放行。
 *
 * 安全原则：
 *   - 无配置 / 无匹配 hook / 执行报错 / 超时，一律放行（不改变现有行为）；
 *   - 默认超时 10s，超时放行。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getBaseDir } = require('../core/agent-runtime/paths');
const { logger } = require('../core/logger');

const DEFAULT_TIMEOUT = 10 * 1000;

// 配置缓存：记录文件路径 + mtime，文件变化时重新加载
let _cache = null; // { file, mtimeMs, data }

/** 配置文件路径：<baseDir>/hooks.json */
function getConfigPath() {
  return path.join(getBaseDir(), 'hooks.json');
}

/**
 * 加载 hooks 配置（带 mtime 缓存）。
 * 文件不存在 / 解析失败，一律返回空对象（等价于无配置）。
 */
function loadConfig() {
  const file = getConfigPath();
  try {
    const st = fs.statSync(file);
    if (_cache && _cache.file === file && _cache.mtimeMs === st.mtimeMs) {
      return _cache.data;
    }
    const raw = fs.readFileSync(file, 'utf8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      logger.warn('[hooks] hooks.json 解析失败，视为无配置:', e && e.message);
      data = {};
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
    _cache = { file, mtimeMs: st.mtimeMs, data };
    return data;
  } catch (_) {
    // 文件不存在等：缓存空配置
    _cache = { file, mtimeMs: null, data: {} };
    return {};
  }
}

/**
 * 快速判断某事件是否配置了 hook（无配置时零开销，供调用点提前短路）。
 * @param {string} eventName 如 'PreToolUse' / 'PostToolUse'
 * @returns {boolean}
 */
function hasHooks(eventName) {
  const cfg = loadConfig();
  const list = cfg[eventName];
  return Array.isArray(list) && list.length > 0;
}

/**
 * 找出匹配某工具名的事件 hook 列表。
 * @param {string} eventName
 * @param {string} tool 工具名
 */
function matchHooks(eventName, tool) {
  const cfg = loadConfig();
  const list = cfg[eventName];
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const h of list) {
    if (!h || typeof h.command !== 'string' || !h.command.trim()) continue;
    const m = h.matcher;
    if (m == null || m === '' || m === '*') {
      out.push(h);
      continue;
    }
    try {
      if (new RegExp(m).test(tool || '')) out.push(h);
    } catch (e) {
      // 非法正则：跳过该 hook（失败放行）
      logger.warn('[hooks] matcher 非法正则，跳过:', m);
    }
  }
  return out;
}

/**
 * 解析 hook 子进程输出。
 * @param {number|null} code 退出码
 * @param {string} stdout
 * @param {string} stderr
 * @returns {{decision: string, reason?: string, additionalContext?: string, modifiedInput?: object}}
 */
function parseHookOutput(code, stdout, stderr) {
  const trimmed = (stdout || '').trim();
  let parsed = null;
  if (trimmed) {
    try {
      parsed = JSON.parse(trimmed);
    } catch (_) {
      // 可能是多行输出，取最后一行可解析的 JSON
      const lines = trimmed.split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (!t) continue;
        try { parsed = JSON.parse(t); break; } catch (_) { /* 继续 */ }
      }
    }
  }

  // 退出码 2 = 阻断（最高优先级，以退出码为准）
  if (code === 2) {
    const reason =
      (parsed && (parsed.reason || parsed.message)) ||
      trimmed ||
      (stderr || '').trim() ||
      'hook 阻止了操作';
    return { decision: 'deny', reason };
  }

  // 退出码 0 = 放行；stdout 若为 JSON 则读取 decision/additionalContext/modifiedInput
  if (code === 0 && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const out = { decision: 'allow' };
    const d = parsed.decision;
    if (d === 'deny' || d === 'block') out.decision = 'deny';
    else if (d === 'ask' || d === 'confirm') out.decision = 'ask';
    else if (d === 'allow' || d == null) out.decision = 'allow';
    else out.decision = 'allow';
    if (parsed.reason) out.reason = parsed.reason;
    if (parsed.additionalContext) out.additionalContext = parsed.additionalContext;
    if (parsed.modifiedInput && typeof parsed.modifiedInput === 'object') {
      out.modifiedInput = parsed.modifiedInput;
    }
    return out;
  }

  // 其他退出码 / 无有效输出 = 失败放行
  return { decision: 'allow' };
}

/**
 * 执行单个 hook 子进程。
 * @param {string} command 命令行（经 shell 执行，兼容 "node xxx.js" 写法）
 * @param {object} payload 写入 stdin 的 JSON 对象
 * @param {number} [timeoutMs]
 * @returns {Promise<object>} 解析后的结果；任何异常都 resolve({decision:'allow'})
 */
function execHook(command, payload, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : DEFAULT_TIMEOUT;
    let child;
    try {
      child = spawn(command, { shell: true, windowsHide: true });
    } catch (e) {
      logger.error('[hooks] spawn 失败，放行:', e && e.message);
      return resolve({ decision: 'allow' });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch (_) { /* 忽略 */ }
      resolve(val);
    };
    const timer = setTimeout(() => {
      logger.warn('[hooks] hook 超时（' + timeout + 'ms）放行:', command);
      finish({ decision: 'allow' });
    }, timeout);

    if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      logger.error('[hooks] 子进程错误，放行:', e && e.message);
      finish({ decision: 'allow' });
    });
    child.on('close', (code) => {
      finish(parseHookOutput(code, stdout, stderr));
    });

    try {
      child.stdin.write(JSON.stringify(payload) + '\n');
      child.stdin.end();
    } catch (e) {
      logger.error('[hooks] 写入 stdin 失败，放行:', e && e.message);
      finish({ decision: 'allow' });
    }
  });
}

/**
 * 运行某事件的全部匹配 hook，聚合结果。
 *
 * 返回值：
 *   { decision: 'allow' | 'deny' | 'ask', reason?, modifiedInput?, additionalContext? }
 * - 任一 hook 返回 deny → 立即返回 deny；
 * - 任一 hook 返回 ask  → 立即返回 ask（交给确认回环）；
 * - allow 的 additionalContext 依次拼接，modifiedInput 依次合并；
 * - 无配置 / 无匹配 / 全部异常 → { decision: 'allow' }。
 *
 * @param {string} eventName 'PreToolUse' | 'PostToolUse'
 * @param {object} payload 事件负载（含 tool 字段用于 matcher 匹配）
 * @param {object} [opts] { tool?, timeoutMs? }
 */
async function runHook(eventName, payload, opts) {
  opts = opts || {};
  const allow = { decision: 'allow' };

  let hooks;
  try {
    const tool = (opts.tool != null ? opts.tool : (payload && payload.tool)) || '';
    hooks = matchHooks(eventName, tool);
  } catch (e) {
    logger.error('[hooks] 读取配置失败，放行:', e && e.message);
    return allow;
  }
  if (!hooks.length) return allow;

  const basePayload = Object.assign({ event: eventName }, payload || {});
  const result = { decision: 'allow' };

  for (const h of hooks) {
    let r;
    try {
      r = await execHook(h.command, basePayload, opts.timeoutMs);
    } catch (e) {
      logger.error('[hooks] 执行 hook 异常，放行:', e && e.message);
      continue;
    }
    if (!r) continue;

    if (r.decision === 'deny') {
      return { decision: 'deny', reason: r.reason || ('hook 阻止: ' + h.command) };
    }
    if (r.decision === 'ask') {
      return { decision: 'ask', reason: r.reason || '' };
    }
    // allow：聚合附加信息 / 输入修改
    if (r.additionalContext) {
      result.additionalContext = result.additionalContext
        ? result.additionalContext + '\n' + r.additionalContext
        : r.additionalContext;
    }
    if (r.modifiedInput && typeof r.modifiedInput === 'object') {
      result.modifiedInput = Object.assign(result.modifiedInput || {}, r.modifiedInput);
    }
  }

  return result;
}

module.exports = {
  getConfigPath,
  loadConfig,
  hasHooks,
  matchHooks,
  parseHookOutput,
  runHook,
};
