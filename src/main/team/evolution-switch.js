/**
 * 自进化飞轮总开关（Evolution Switch）—— 三个无人干预驱动器的统一闸门
 *
 * 背景（重要）：系统有 3 个无人干预驱动器：
 *   1. self-loop-driver（自驱循环）
 *   2. auto-evolve（自动进化）
 *   3. curator（引导者 / 战略巡检）
 * 过去只有 curator 有自己的 enabled 开关，另两个无条件运行，
 * 用户"关掉引导器"后另两个仍在跑 → 误以为关了实际没关。
 *
 * 本模块提供**统一的上层总开关**，持久化于 userData/evolution-config.json：
 *   { "enabled": false }   // 默认关
 * 三个驱动器都必须在运行前 / 每次 tick 前查询 isEnabled()，
 * 总开关关 → 一律不注入、不巡检、不维护。
 *
 * 设计原则：
 *  - 纯 Node 容错（try/catch，失败不抛）
 *  - 默认关（enabled=false）
 *  - 不破坏 curator 自身的 enabled 语义（总开关是它的上层）
 */
const fs = require('fs');
const path = require('path');
const { getBaseDir } = require('../../core/agent-runtime/paths');

const DEFAULT_CONFIG = { enabled: false };

let cached = null;       // 内存缓存（避免频繁读盘）
let configFile = null;

/** 配置文件路径（惰性；getBaseDir 内部已含 app 未就绪时的临时目录兜底） */
function getConfigFile() {
  if (configFile) return configFile;
  configFile = path.join(getBaseDir(), 'evolution-config.json');
  return configFile;
}

/** 读取配置（带缓存） */
function getConfig() {
  if (cached) return { enabled: !!cached.enabled };
  let out = { enabled: DEFAULT_CONFIG.enabled };
  try {
    const f = getConfigFile();
    if (fs.existsSync(f)) {
      const obj = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (obj && typeof obj === 'object') {
        out.enabled = obj.enabled === true;
      }
    }
  } catch (e) {
    // 读取失败 → 保持默认（关）
    out.enabled = DEFAULT_CONFIG.enabled;
  }
  cached = out;
  return { enabled: !!cached.enabled };
}

/** 总开关是否开启（关 = 三个驱动器全部停止工作） */
function isEnabled() {
  try {
    return !!getConfig().enabled;
  } catch (_) {
    return false;
  }
}

/** 写入总开关（持久化） */
function setEnabled(enabled) {
  const val = enabled === true;
  cached = { enabled: val };
  try {
    const f = getConfigFile();
    const dir = path.dirname(f);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ enabled: val }, null, 2), 'utf-8');
    return { success: true, enabled: val };
  } catch (e) {
    return { success: false, enabled: val, error: e.message };
  }
}

/** 供测试重置缓存 */
function _reset() {
  cached = null;
  configFile = null;
}

/** 供测试指定配置文件路径（避免污染真实 userData） */
function _setConfigFile(f) {
  configFile = f;
  cached = null;
}

module.exports = { DEFAULT_CONFIG, getConfig, getConfigFile, isEnabled, setEnabled, _reset, _setConfigFile };
