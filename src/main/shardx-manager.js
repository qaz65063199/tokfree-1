'use strict';
/**
 * ShardX 反检测浏览器 —— 无感就位管理
 *
 * 首次启动时静默就位 ShardX：
 *   1) 检测 Launcher 是否安装（%LOCALAPPDATA%\ShardX Launcher\shardx-launcher.exe）
 *   2) 未装则用随包分发的 ShardX-setup.exe /S 静默安装
 *   3) 把 MCP 桥接（shardx-mcp/）复制到 userData 下
 *   4) 启动 Launcher（若未运行）
 *   5) 生成 shardx MCP server 启动配置（含现签 JWT）
 *
 * 设计原则：全部函数幂等 + 全 try/catch（失败静默返回 {ok:false}，绝不影响主流程）。
 * 不 require electron 顶层（延迟 require，避免单测环境崩溃）。
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_API_PORT = 40325;
const DEFAULT_API_HOST = '127.0.0.1';
const JWT_TTL_SECONDS = 315360000; // 10 年

/** 取用户数据根目录：优先 paths.getBaseDir() 注入值 */
function getBaseDir() {
  try {
    return require('../core/agent-runtime/paths').getBaseDir();
  } catch (_) {}
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (_) {}
  try { return require('os').tmpdir(); } catch (_) { return process.cwd(); }
}

/** 取随包分发的 ShardX 资产目录（打包后 resources/shardx，dev 走项目根 resources/shardx） */
function getResourcesShardxDir() {
  if (process.env.TOKFREE_SHARDX_ASSETS) return process.env.TOKFREE_SHARDX_ASSETS;
  try {
    const { app } = require('electron');
    if (app && app.isPackaged && process.resourcesPath) {
      return path.join(process.resourcesPath, 'shardx');
    }
  } catch (_) {}
  return path.join(__dirname, '..', '..', 'resources', 'shardx');
}

function getLocalAppDataDir() {
  if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
  try { return path.join(require('os').homedir(), 'AppData', 'Local'); } catch (_) { return null; }
}

function getAppDataDir() {
  if (process.env.APPDATA) return process.env.APPDATA;
  try { return path.join(require('os').homedir(), 'AppData', 'Roaming'); } catch (_) { return null; }
}

/** Launcher 可执行文件路径（存在才返回，否则 null） */
function getLauncherExePath() {
  try {
    const base = getLocalAppDataDir();
    if (!base) return null;
    const p = path.join(base, 'ShardX Launcher', 'shardx-launcher.exe');
    return fs.existsSync(p) ? p : null;
  } catch (_) {
    return null;
  }
}

/** Launcher 是否已安装 */
function isLauncherInstalled() {
  return !!getLauncherExePath();
}

/**
 * 静默安装 Launcher（NSIS /S）。
 * @returns {Promise<{ok:boolean, already?:boolean, error?:string}>}
 */
async function installLauncher() {
  try {
    if (isLauncherInstalled()) return { ok: true, already: true };
    const setupPath = path.join(getResourcesShardxDir(), 'ShardX-setup.exe');
    if (!fs.existsSync(setupPath)) {
      return { ok: false, error: 'setup not found: ' + setupPath };
    }
    const cp = require('child_process');
    await new Promise((resolve, reject) => {
      try {
        cp.execFile(setupPath, ['/S'], { timeout: 120000 }, (err) => {
          if (err) reject(err); else resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
    if (isLauncherInstalled()) return { ok: true };
    return { ok: false, error: 'installed but launcher not found' };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/** 递归复制目录（优先 fs.cpSync，回退自实现） */
function copyDirSync(src, dest) {
  if (typeof fs.cpSync === 'function') {
    fs.cpSync(src, dest, { recursive: true });
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDirSync(s, d);
    else if (e.isSymbolicLink()) { try { fs.symlinkSync(fs.readlinkSync(s), d); } catch (_) {} }
    else fs.copyFileSync(s, d);
  }
}

/**
 * 就位 MCP 桥接：把 resources/shardx/shardx-mcp/ 复制到 <userData>/shardx-mcp/。
 * 幂等：目标已有 index.js 则直接返回。
 * @returns {{ok:boolean, dir:string, error?:string}}
 */
function ensureMcpAssets() {
  let dir = '';
  try {
    dir = path.join(getBaseDir(), 'shardx-mcp');
    if (fs.existsSync(path.join(dir, 'index.js'))) return { ok: true, dir };
    const src = path.join(getResourcesShardxDir(), 'shardx-mcp');
    if (!fs.existsSync(src)) return { ok: false, dir, error: 'src not found: ' + src };
    copyDirSync(src, dir);
    if (!fs.existsSync(path.join(dir, 'index.js'))) {
      return { ok: false, dir, error: 'copy incomplete' };
    }
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, dir, error: (e && e.message) || String(e) };
  }
}

/** 读 Launcher 配置（%APPDATA%/shardx-launcher/settings.json），容错返回 null */
function readLauncherSettings() {
  try {
    const base = getAppDataDir();
    if (!base) return null;
    const p = path.join(base, 'shardx-launcher', 'settings.json');
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (_) {
    return null;
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 用 api_secret 现签 HS256 JWT（payload {sub:"api", iat, exp}） */
function buildJwt(secret) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub: 'api', iat: now, exp: now + JWT_TTL_SECONDS }));
  const crypto = require('crypto');
  const sig = b64url(crypto.createHmac('sha256', secret).update(header + '.' + payload).digest());
  return header + '.' + payload + '.' + sig;
}

/**
 * 生成 shardx MCP server 启动配置。
 * @returns {{command:string, args:string[], env:object}|null} 读不到 settings/api_secret 时返回 null
 */
function buildMcpServerConfig() {
  try {
    const settings = readLauncherSettings();
    if (!settings || !settings.api_secret) return null;
    const port = settings.api_port || DEFAULT_API_PORT;
    const token = buildJwt(settings.api_secret);
    return {
      command: 'node',
      args: [path.join(getBaseDir(), 'shardx-mcp', 'index.js')],
      env: {
        SHARDX_API: 'http://' + DEFAULT_API_HOST + ':' + port,
        SHARDX_TOKEN: token,
      },
    };
  } catch (_) {
    return null;
  }
}

/** 探测 Launcher 是否在运行（HTTP 探测 api 端口） */
function isLauncherRunning() {
  return new Promise((resolve) => {
    try {
      const http = require('http');
      const settings = readLauncherSettings() || {};
      const port = settings.api_port || DEFAULT_API_PORT;
      const req = http.get({ host: DEFAULT_API_HOST, port, path: '/', timeout: 800 }, (res) => {
        try { res.resume(); } catch (_) {}
        resolve(true);
        try { req.destroy(); } catch (_) {}
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(false); });
    } catch (_) {
      resolve(false);
    }
  });
}

/**
 * 启动 Launcher（若未运行）。detached + unref，不阻塞。
 * @returns {Promise<{ok:boolean, already?:boolean, error?:string}>}
 */
async function startLauncher() {
  try {
    const exePath = getLauncherExePath();
    if (!exePath) return { ok: false, error: 'launcher not installed' };
    if (await isLauncherRunning()) return { ok: true, already: true };
    const cp = require('child_process');
    const child = cp.spawn(exePath, [], { detached: true, stdio: 'ignore' });
    if (child && typeof child.unref === 'function') child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// 模块级就绪缓存：30s 内重复调用直接返回，避免每次工具调用都装/启。
let lastReadyAt = 0;

/**
 * 「用点即自愈」：任何 ShardX 工具被调用前先确保 Launcher 就绪。
 * 未装则装、未运行则启；全 try/catch，绝不抛错阻塞主流程。
 * 30s 内重复调用直接命中缓存（传 {force:true} 可强制重跑）。
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, installed?:boolean, running?:boolean, mcpReady?:boolean, cached?:boolean, error?:string}>}
 */
async function ensureShardxReady(opts) {
  const force = !!(opts && opts.force);
  try {
    if (!force && lastReadyAt && Date.now() - lastReadyAt < 30000) {
      return { ok: true, cached: true };
    }
    let installed = isLauncherInstalled();
    let error;
    let mcpReady = false;

    // 1) 就位 MCP 桥接资源
    try {
      const mcp = ensureMcpAssets();
      mcpReady = !!(mcp && mcp.ok);
    } catch (_) {}

    // 2) 未安装则静默安装
    if (!installed) {
      try {
        const ir = await installLauncher();
        if (ir && ir.ok) installed = isLauncherInstalled();
        else if (ir && ir.error) error = ir.error;
      } catch (e) {
        error = (e && e.message) || String(e);
      }
    }

    if (!installed) {
      return { ok: false, installed: false, running: false, mcpReady, error: error || 'launcher not installed' };
    }

    // 3) 启动 Launcher（内部会先探测是否已在运行）
    let running = false;
    try {
      const sr = await startLauncher();
      if (sr && sr.ok) running = true;
      else if (sr && sr.error) error = sr.error;
      if (sr && sr.already) running = true;
    } catch (e) {
      error = (e && e.message) || String(e);
    }

    // 4) 若仍探测不到运行，用 HTTP 再确认一次
    if (!running) {
      try { running = await isLauncherRunning(); } catch (_) {}
    }

    if (running) {
      lastReadyAt = Date.now();
      return { ok: true, installed, running, mcpReady };
    }
    return { ok: false, installed, running: false, mcpReady, error: error || 'launcher not running' };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 编排：安装 → 就位 MCP → 启动 Launcher。
 * @returns {Promise<{ok:boolean, installed:boolean, mcpReady:boolean, error?:string}>}
 */
async function ensureShardx() {
  let installed = isLauncherInstalled();
  let error;
  try {
    if (!installed) {
      const r = await installLauncher();
      if (r && r.ok) installed = isLauncherInstalled();
      else if (r && r.error) error = r.error;
    }
    const mcp = ensureMcpAssets();
    const mcpReady = !!(mcp && mcp.ok);
    if (installed) {
      try { await startLauncher(); } catch (_) {}
    }
    return { ok: true, installed, mcpReady, error };
  } catch (e) {
    return { ok: false, installed, mcpReady: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 查询当前就位状态（只读，不触发安装/复制），供设置面板展示。
 * @returns {{installed:boolean, mcpReady:boolean, mcpConfigured:boolean, launcherExePath:string|null, error?:string}}
 */
function getStatus() {
  try {
    const exe = getLauncherExePath();
    let mcpReady = false;
    try {
      mcpReady = fs.existsSync(path.join(getBaseDir(), 'shardx-mcp', 'index.js'));
    } catch (_) {}
    let mcpConfigured = false;
    try {
      const cfg = require('./mcp-config').readConfig();
      mcpConfigured = !!(cfg && cfg.mcpServers && cfg.mcpServers.shardx);
    } catch (_) {}
    return { installed: !!exe, mcpReady, mcpConfigured, launcherExePath: exe || null };
  } catch (e) {
    return { installed: false, mcpReady: false, mcpConfigured: false, launcherExePath: null, error: (e && e.message) || String(e) };
  }
}

module.exports = {
  isLauncherInstalled,
  getStatus,
  getLauncherExePath,
  installLauncher,
  ensureMcpAssets,
  readLauncherSettings,
  buildMcpServerConfig,
  startLauncher,
  ensureShardx,
  ensureShardxReady,
  // 内部辅助（便于测试）
  _internal: { b64url, buildJwt, getResourcesShardxDir, getBaseDir, isLauncherRunning, copyDirSync },
};
