/**
 * MCP Client 管理
 * 连接/管理多个 MCP server（stdio + HTTP），提供工具列表和调用能力。
 */
const { Client } = require('../../node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
const { StdioClientTransport } = require('../../node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js');
const { StreamableHTTPClientTransport } = require('../../node_modules/@modelcontextprotocol/sdk/dist/cjs/client/streamableHttp.js');
const mcpConfig = require('./mcp-config');
const fs = require('fs');
const path = require('path');

// MCP 默认工作目录：让 stdio server 的产物（截图/下载）有确定落点，
// AI 可用绝对路径定位。优先「程序目录/mcp-cwd」，不可写则回退 userData/mcp-cwd。
let _defaultCwd = null;
function getDefaultCwd() {
  if (_defaultCwd !== null) return _defaultCwd;
  const candidates = [];
  try { candidates.push(path.join(process.cwd(), 'mcp-cwd')); } catch (_) {}
  try {
    const { app } = require('electron');
    candidates.push(path.join(app.getPath('userData'), 'mcp-cwd'));
  } catch (_) {}
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 可写性测试
      const probe = path.join(dir, '.write-test');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      _defaultCwd = dir;
      console.log('[MCP] 默认工作目录:', dir);
      return _defaultCwd;
    } catch (_) { /* 试下一个 */ }
  }
  _defaultCwd = '';
  return _defaultCwd;
}

// server name -> { client, transport, tools, connected }
const connections = new Map();
// 并发连接去重（in-flight）：server name -> Promise。
// 修复竞态：connectEnabledServers（初始化）与 callMcpTool（按需）可能同时
// 触发同一 server 连接 → 重复 spawn 子进程 / 连接泄漏。
const connecting = new Map();

async function connectServer(server) {
  if (connecting.has(server.name)) {
    return connecting.get(server.name);
  }
  const p = doConnectServer(server).finally(function () {
    connecting.delete(server.name);
  });
  connecting.set(server.name, p);
  return p;
}

async function doConnectServer(server) {
  const existing = connections.get(server.name);
  if (existing) {
    // 传输仍存活（client._transport 由 SDK 在连接关闭时置空）：直接复用
    if (existing.connected && existing.client && existing.client._transport) {
      return existing;
    }
    // 陈旧连接：清理后重连，避免复用已死连接导致 "Not connected"
    console.warn('[MCP] 连接已失效，重新连接:', server.name);
    try { await existing.client.close(); } catch (_) {}
    connections.delete(server.name);
  }

  let transport;
  if (server.type === 'stdio') {
    transport = new StdioClientTransport({
      command: server.command,
      args: server.args || [],
      env: server.env || {},
      cwd: server.cwd || getDefaultCwd() || undefined,
      stderr: 'pipe',
    });
  } else if (server.type === 'http') {
    transport = new StreamableHTTPClientTransport(server.url, {
      requestInit: server.headers ? { headers: server.headers } : undefined,
    });
  } else {
    throw new Error('未知 MCP server 类型: ' + server.type);
  }

  const client = new Client({ name: 'tokfree', version: '0.2.4' });
  await client.connect(transport);

  let tools = [];
  try {
    const result = await client.listTools({});
    tools = result.tools || [];
  } catch (err) {
    console.error('[MCP] 获取工具列表失败:', server.name, err.message);
  }

  const entry = { client, transport, tools, connected: true };
  connections.set(server.name, entry);
  console.log('[MCP] 已连接:', server.name, '工具数=', tools.length);
  return entry;
}

async function disconnectServer(name) {
  const entry = connections.get(name);
  if (!entry) return;
  try {
    await entry.client.close();
  } catch (_) {}
  connections.delete(name);
  console.log('[MCP] 已断开:', name);
}

async function refreshServerTools(name) {
  const entry = connections.get(name);
  if (!entry) return [];
  try {
    const result = await entry.client.listTools({});
    entry.tools = result.tools || [];
    return entry.tools;
  } catch (err) {
    console.error('[MCP] 刷新工具列表失败:', name, err.message);
    return entry.tools || [];
  }
}

async function connectEnabledServers() {
  const servers = mcpConfig.getEnabledServers();
  for (const server of servers) {
    try {
      await connectServer(server);
    } catch (err) {
      console.error('[MCP] 连接失败:', server.name, err.message);
    }
  }
  return Array.from(connections.keys());
}

async function connectServerByName(name) {
  const server = mcpConfig.getServers().find(s => s.name === name && s.enabled);
  if (!server) throw new Error('MCP server 不存在或未启用: ' + name);
  return connectServer(server);
}

async function disconnectServerByName(name) {
  await disconnectServer(name);
}

async function callMcpTool(serverName, toolName, args) {
  let entry = connections.get(serverName);
  if (!entry || !entry.client || !entry.client._transport) {
    entry = await connectServerByName(serverName);
  }
  try {
    return await entry.client.callTool({ name: toolName, arguments: args });
  } catch (err) {
    // 连接在两次调用之间失效：清理陈旧连接，重连后重试一次
    if (err && /not connected/i.test(err.message || '')) {
      console.warn('[MCP] 调用时发现连接失效，重连后重试:', serverName);
      try { await entry.client.close(); } catch (_) {}
      connections.delete(serverName);
      const fresh = await connectServerByName(serverName);
      return await fresh.client.callTool({ name: toolName, arguments: args });
    }
    throw err;
  }
}

function getConnectedServers() {
  const out = [];
  for (const [name, entry] of connections) {
    out.push({ name, tools: entry.tools, connected: entry.connected });
  }
  return out;
}

function getMcpToolList() {
  const out = [];
  for (const [serverName, entry] of connections) {
    for (const tool of entry.tools) {
      out.push({
        server: serverName,
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema || {},
      });
    }
  }
  return out;
}

/**
 * 列出所有已配置的 MCP server（含启用状态和连接状态）
 * @returns {Array<{name, type, enabled, connected, toolCount}>}
 */
function listConfiguredServers() {
  const servers = mcpConfig.getServers();
  return servers.map(s => {
    const entry = connections.get(s.name);
    // 传输对象由 SDK 在连接关闭时置空，是比 connected 标志更可靠的存活判据
    const alive = !!(entry && entry.client && entry.client._transport);
    return {
      name: s.name,
      type: s.type,
      enabled: s.enabled,
      connected: alive,
      toolCount: entry ? entry.tools.length : 0,
    };
  });
}

/**
 * 获取指定 server 的工具列表（按需连接）
 * @param {string} name server 名称
 * @returns {Array<{name, description, inputSchema}>}
 */
async function getToolsByServer(name) {
  let entry = connections.get(name);
  if (!entry) {
    entry = await connectServerByName(name);
  }
  return entry.tools.map(t => ({
    name: t.name,
    description: t.description || '',
    inputSchema: t.inputSchema || {},
  }));
}

module.exports = {
  connectServer,
  disconnectServer,
  refreshServerTools,
  connectEnabledServers,
  connectServerByName,
  disconnectServerByName,
  callMcpTool,
  getConnectedServers,
  getMcpToolList,
  listConfiguredServers,
  getToolsByServer,
};
