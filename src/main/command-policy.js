/**
 * 命令策略（三级：allow / confirm / deny）
 * 对标 Cline / Roo Code 的命令白名单与权限分级。
 *
 * 规则来源：内置默认（黑名单兜底）+ 用户配置（userData/command-policy.json）
 *
 * 判定顺序（优先级从高到低）：
 *   1. deny   —— 任一用户规则命中即拒绝（匹配整条命令，防绕过；信任模式也不能跳过）
 *   2. allow  —— 命中即自动批准；若命令含 shell 链接/替换（; | & ` $( 等），
 *                自动降级为 confirm，防 `npm test; rm -rf /` 之类绕过
 *   3. confirm—— 命中即需用户确认（信任模式下自动放行）
 *   4. 未命中 —— 由 tool-policy 现有 isDangerous 黑名单兜底（保持向后兼容）
 *
 * 规则结构：{ id, pattern, type?: 'regex'|'prefix', flags?, action, note? }
 *   - type='regex'（默认）：pattern 为正则源码，flags 默认 'i'（大小写不敏感）
 *   - type='prefix'：pattern 作为字面前缀，内部转义后锚定 ^ 匹配
 *
 * 存储（userData/command-policy.json）：{ "rules": [ ...用户规则... ] }
 * 损坏容错：文件结构非法 / JSON 解析失败时改名备份（.corrupt-<时间戳>），风格参照 tool-policy.js。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { DANGEROUS_CMDS } = require('./dangerous-commands');

const VALID_ACTIONS = ['allow', 'confirm', 'deny'];
// shell 链接 / 命令替换字符：allow 命中但命令含这些字符时降级为 confirm
const CHAIN_RE = /[;&|`]|\$\(/;

let cache = null;

function getConfigFile() {
  return path.join(app.getPath('userData'), 'command-policy.json');
}

/** 把损坏文件改名备份，避免静默覆盖 */
function backupCorruptFile(file, reason) {
  try {
    if (!fs.existsSync(file)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(file, file + '.corrupt-' + stamp);
    console.error('[CommandPolicy] 文件损坏已备份(' + reason + '):', file);
  } catch (e) {
    console.error('[CommandPolicy] 备份损坏文件失败:', e.message);
  }
}

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
    console.error('[CommandPolicy] 读取配置失败:', err.message);
    backupCorruptFile(getConfigFile(), 'JSON 解析失败');
  }
  return {};
}

function saveAll(obj) {
  cache = obj;
  try {
    fs.writeFileSync(getConfigFile(), JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    console.error('[CommandPolicy] 写入配置失败:', err.message);
  }
}

/** 校验并编译单条规则 → RegExp，非法返回 null */
function compileRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  if (typeof rule.pattern !== 'string' || !rule.pattern) return null;
  if (VALID_ACTIONS.indexOf(rule.action) === -1) return null;
  try {
    if (rule.type === 'prefix') {
      const escaped = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('^' + escaped, rule.flags || 'i');
    }
    return new RegExp(rule.pattern, rule.flags || 'i');
  } catch (_) {
    return null;
  }
}

/** 取用户规则（已过滤非法项） */
function getUserRules() {
  const all = loadAll();
  if (!Array.isArray(all.rules)) return [];
  return all.rules.filter((r) => compileRule(r) !== null);
}

/** 内置规则视图（供 IPC/UI 展示；实际兜底由 tool-policy 的 isDangerous 承担） */
function getBuiltinRulesView() {
  return DANGEROUS_CMDS.map((re, i) => ({
    id: 'builtin-' + i,
    pattern: re.source,
    flags: re.flags,
    action: 'confirm',
    note: '内置危险命令（黑名单兜底）',
    builtin: true,
  }));
}

/**
 * 核心判定：按 deny > allow > confirm 顺序匹配用户规则。
 * @param {string} cmd
 * @returns {{matched:boolean, action?:'allow'|'confirm'|'deny', rule?:object, note?:string}}
 */
function evaluateCommandPolicy(cmd) {
  const raw = typeof cmd === 'string' ? cmd.trim() : '';
  if (!raw) return { matched: false };
  const rules = getUserRules();

  // 1. deny 优先（匹配整条命令，防绕过）
  for (const r of rules) {
    if (r.action !== 'deny') continue;
    const re = compileRule(r);
    if (re.test(raw)) {
      return { matched: true, action: 'deny', rule: r, note: r.note || '命中 deny 规则' };
    }
  }

  // 2. allow（含 shell 链接/替换时降级 confirm）
  const chained = CHAIN_RE.test(raw);
  for (const r of rules) {
    if (r.action !== 'allow') continue;
    const re = compileRule(r);
    if (re.test(raw)) {
      if (chained) {
        return { matched: true, action: 'confirm', rule: r, note: '命令含 shell 链接/替换，allow 规则降级为确认' };
      }
      return { matched: true, action: 'allow', rule: r, note: r.note || '命中 allow 规则' };
    }
  }

  // 3. confirm
  for (const r of rules) {
    if (r.action !== 'confirm') continue;
    const re = compileRule(r);
    if (re.test(raw)) {
      return { matched: true, action: 'confirm', rule: r, note: r.note || '命中 confirm 规则' };
    }
  }

  return { matched: false };
}

/** 配置视图（内置规则 + 用户规则） */
function getConfig() {
  const all = loadAll();
  return {
    builtinRules: getBuiltinRulesView(),
    rules: Array.isArray(all.rules) ? all.rules.slice() : [],
  };
}

/** 新增一条用户规则，返回归一化后的规则 */
function addRule(rule) {
  if (!rule || typeof rule !== 'object') throw new Error('规则必须为对象');
  if (VALID_ACTIONS.indexOf(rule.action) === -1) throw new Error('action 必须是 allow/confirm/deny');
  if (typeof rule.pattern !== 'string' || !rule.pattern.trim()) throw new Error('pattern 不能为空');
  const normalized = {
    id: rule.id || ('user-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)),
    pattern: rule.pattern,
    type: rule.type === 'prefix' ? 'prefix' : 'regex',
    flags: rule.flags || 'i',
    action: rule.action,
    note: rule.note || '',
  };
  if (compileRule(normalized) === null) throw new Error('规则无法编译（正则非法或类型错误）');
  const all = loadAll();
  if (!Array.isArray(all.rules)) all.rules = [];
  all.rules.push(normalized);
  saveAll(all);
  return normalized;
}

/** 删除一条用户规则 */
function removeRule(id) {
  const all = loadAll();
  if (!Array.isArray(all.rules)) return false;
  const before = all.rules.length;
  all.rules = all.rules.filter((r) => r.id !== id);
  const removed = all.rules.length < before;
  if (removed) saveAll(all);
  return removed;
}

/** 整体替换用户规则（逐条校验，非法则抛错，不写入） */
function setRules(rules) {
  if (!Array.isArray(rules)) throw new Error('rules 必须是数组');
  const normalized = rules.map((r, i) => {
    if (!r || typeof r !== 'object') throw new Error('第 ' + (i + 1) + ' 条规则非法');
    if (VALID_ACTIONS.indexOf(r.action) === -1) throw new Error('第 ' + (i + 1) + ' 条 action 非法');
    const n = {
      id: r.id || ('user-' + Date.now() + '-' + i),
      pattern: r.pattern,
      type: r.type === 'prefix' ? 'prefix' : 'regex',
      flags: r.flags || 'i',
      action: r.action,
      note: r.note || '',
    };
    if (compileRule(n) === null) throw new Error('第 ' + (i + 1) + ' 条规则无法编译');
    return n;
  });
  const all = loadAll();
  all.rules = normalized;
  saveAll(all);
  return normalized;
}

function _resetCache() {
  cache = null;
}

module.exports = {
  VALID_ACTIONS,
  evaluateCommandPolicy,
  compileRule,
  getUserRules,
  getBuiltinRulesView,
  getConfig,
  addRule,
  removeRule,
  setRules,
  _resetCache,
};
