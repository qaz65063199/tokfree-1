/**
 * 多 Agent 模式配置（按窗口独立）
 * - 'single'（默认）：单聊模式，AI 直接完成任务
 * - 'multi'：多 Agent 模式，主 Agent 作为"总经理"调度多个子 Agent
 *
 * 持久化到 userData/team-mode.json，按 profileId 分别记录，各窗口互不影响。
 * 结构：{ "profile-xxx": "multi", "profile-yyy": "single", ... }
 */
const fs = require('fs');
const path = require('path');
const { getBaseDir } = require('../../core/agent-runtime/paths');

const DEFAULT_MODE = 'single';
let cache = null; // { [profileId]: 'single'|'multi' }

function getConfigFile() {
  return path.join(getBaseDir(), 'team-mode.json');
}

/** 读取整份配置 */
function loadAll() {
  if (cache) return cache;
  try {
    const f = getConfigFile();
    if (fs.existsSync(f)) {
      const obj = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (obj && typeof obj === 'object') {
        // 兼容旧的全局格式 { mode: 'multi' }：迁移为默认窗口模式，其余用默认
        if (typeof obj.mode === 'string') {
          cache = { __legacyDefault: obj.mode };
          return cache;
        }
        cache = obj;
        return cache;
      }
    }
  } catch (err) {
    console.error('[TeamMode] 读取模式配置失败:', err.message);
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
    console.error('[TeamMode] 写入模式配置失败:', err.message);
  }
}

/**
 * 读取某窗口的模式
 * @param {string} [profileId] 缺省时返回全局默认
 */
function getMode(profileId) {
  const all = loadAll();
  if (profileId && all[profileId]) return all[profileId];
  if (!profileId && all.__legacyDefault) return all.__legacyDefault;
  return DEFAULT_MODE;
}

/** 设置某窗口的模式 */
function setMode(mode, profileId) {
  const m = mode === 'multi' ? 'multi' : 'single';
  if (!profileId) {
    // 无 profileId：仅更新 legacy 默认
    const all = loadAll();
    all.__legacyDefault = m;
    saveAll(all);
    return m;
  }
  const all = loadAll();
  all[profileId] = m;
  saveAll(all);
  console.log('[TeamMode] 模式已保存 profile=' + profileId + ' mode=' + m);
  return m;
}

/** 某窗口是否多 Agent 模式 */
function isMulti(profileId) {
  return getMode(profileId) === 'multi';
}

module.exports = { getMode, setMode, isMulti, DEFAULT_MODE };
