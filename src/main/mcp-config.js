/**
 * MCP 配置管理
 *
 * mcp.json 采用主流 Claude Desktop 格式（可直接分享/导入）：
 * {
 *   "mcpServers": {
 *     "filesystem": { "command": "npx", "args": [...] },          // stdio
 *     "remote-db":  { "url": "https://..." }                       // http（扩展）
 *   }
 * }
 *
 * 启用/禁用状态单独存 mcp-state.json（不污染主流格式）：
 * { "filesystem": true, "remote-db": false }
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function getConfigFile() {
  return path.join(app.getPath('userData'), 'mcp.json');
}

function getStateFile() {
  return path.join(app.getPath('userData'), 'mcp-state.json');
}

function readConfig() {
  try {
    const file = getConfigFile();
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch (err) {
    console.error('[MCP] 读取配置失败:', err.message);
  }
  return { mcpServers: {} };
}

function writeConfig(config) {
  try {
    const file = getConfigFile();
    fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf-8');
    console.log('[MCP] 配置已保存:', file);
    return true;
  } catch (err) {
    console.error('[MCP] 写入配置失败:', err.message);
    return false;
  }
}

function readState() {
  try {
    const file = getStateFile();
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch (err) {}
  return {};
}

function writeState(state) {
  try {
    fs.writeFileSync(getStateFile(), JSON.stringify(state, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[MCP] 写入状态失败:', err.message);
    return false;
  }
}

/**
 * 把 mcpServers 对象转成数组（带 name / type / enabled），便于 UI 和 client 使用。
 * type 判断：有 url 就是 http，否则 stdio。
 */
function getServers() {
  const config = readConfig();
  const state = readState();
  const servers = [];
  for (const [name, def] of Object.entries(config.mcpServers || {})) {
    servers.push({
      name,
      type: def && def.url ? 'http' : 'stdio',
      command: def && def.command,
      args: def && def.args || [],
      url: def && def.url,
      headers: def && def.headers,
      env: def && def.env,
      enabled: state[name] !== false, // 默认启用
    });
  }
  return servers;
}

function getEnabledServers() {
  return getServers().filter(s => s.enabled);
}

function upsertServer(server) {
  const config = readConfig();
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  const def = {};
  if (server.type === 'http') {
    if (server.url) def.url = server.url;
    if (server.headers) def.headers = server.headers;
  } else {
    if (server.command) def.command = server.command;
    if (server.args && server.args.length) def.args = server.args;
    if (server.env) def.env = server.env;
  }
  config.mcpServers[server.name] = def;
  writeConfig(config);
  return server;
}

function setServerEnabled(name, enabled) {
  const state = readState();
  state[name] = !!enabled;
  writeState(state);
  return true;
}

function removeServer(name) {
  const config = readConfig();
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  delete config.mcpServers[name];
  writeConfig(config);
  const state = readState();
  delete state[name];
  writeState(state);
  return true;
}

/**
 * 就位 ShardX MCP server 配置（幂等，供启动流程调用）。
 * 只在「不存在」或「本应用先前生成（env.TOKFREE_MANAGED）」时写入；
 * 用户手动配置的 shardx 一律保留，绝不覆盖。
 * @param {Function|object} buildConfig 生成配置的函数或对象：{command, args, env}
 * @returns {{ok:boolean, updated:boolean, reason?:string, error?:string}}
 */
function ensureShardxServer(buildConfig) {
  try {
    const def = typeof buildConfig === 'function' ? buildConfig() : buildConfig;
    if (!def || !def.command) return { ok: false, updated: false, reason: 'no-config' };
    const config = readConfig();
    if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
    const existing = config.mcpServers.shardx;
    const managed = !!(existing && existing.env && existing.env.TOKFREE_MANAGED);
    if (existing && !managed) {
      // 用户手动配置：保留不动
      return { ok: true, updated: false, reason: 'user-config-preserved' };
    }
    const next = {
      command: def.command,
      args: def.args || [],
      env: Object.assign({}, def.env || {}, { TOKFREE_MANAGED: '1' }),
    };
    if (existing && JSON.stringify(existing) === JSON.stringify(next)) {
      return { ok: true, updated: false, reason: 'unchanged' };
    }
    config.mcpServers.shardx = next;
    writeConfig(config);
    return { ok: true, updated: true };
  } catch (e) {
    return { ok: false, updated: false, error: (e && e.message) || String(e) };
  }
}

module.exports = {
  getConfigFile,
  getStateFile,
  readConfig,
  writeConfig,
  getServers,
  getEnabledServers,
  upsertServer,
  setServerEnabled,
  removeServer,
  ensureShardxServer,
};
