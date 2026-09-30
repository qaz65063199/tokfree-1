'use strict';
/**
 * shardx-manager.js 单元测试
 *
 * mock electron / fs / child_process，验证：
 *  1) isLauncherInstalled 检测
 *  2) buildMcpServerConfig 生成的 JWT 结构（三段 base64url）
 *  3) ensureMcpAssets 幂等（目标已存在则不复制）
 *  4) 异常时返回 {ok:false} 不抛
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const origLoad = Module._load;
let userDataDir;
let localAppDataDir;
let appDataDir;
let resourcesDir;
let fakeLauncherExists;
let execFileCalls;
let spawnCalls;

function installMock() {
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath: (name) => (name === 'userData' ? userDataDir : userDataDir),
          isPackaged: false,
        },
      };
    }
    if (request === 'child_process') {
      return {
        execFile: (file, args, opts, cb) => {
          execFileCalls.push({ file, args });
          // 模拟安装成功：安装后创建 launcher 文件
          if (String(file).indexOf('ShardX-setup.exe') !== -1) {
            fakeLauncherExists = true;
            const lp = path.join(localAppDataDir, 'ShardX Launcher', 'shardx-launcher.exe');
            try { fs.mkdirSync(path.dirname(lp), { recursive: true }); fs.writeFileSync(lp, 'x'); } catch (_) {}
          }
          process.nextTick(() => cb && cb(null));
        },
        spawn: (file, args, opts) => {
          spawnCalls.push({ file, args, opts });
          return { unref: () => {} };
        },
      };
    }
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() {
  Module._load = origLoad;
}

function fresh() {
  delete require.cache[require.resolve('../../src/main/shardx-manager')];
  return require('../../src/main/shardx-manager');
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-shardx-ud-'));
  localAppDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-shardx-lad-'));
  appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-shardx-ad-'));
  resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-shardx-res-'));
  fakeLauncherExists = false;
  execFileCalls = [];
  spawnCalls = [];
  process.env.LOCALAPPDATA = localAppDataDir;
  process.env.APPDATA = appDataDir;
  process.env.TOKFREE_SHARDX_ASSETS = resourcesDir;
  installMock();
});

afterEach(() => {
  uninstallMock();
  delete process.env.TOKFREE_SHARDX_ASSETS;
  for (const d of [userDataDir, localAppDataDir, appDataDir, resourcesDir]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

function makeLauncherInstalled() {
  const lp = path.join(localAppDataDir, 'ShardX Launcher', 'shardx-launcher.exe');
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  fs.writeFileSync(lp, 'x');
}

function writeSettings(obj) {
  const p = path.join(appDataDir, 'shardx-launcher', 'settings.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj), 'utf-8');
}

function makeMcpSrc() {
  const d = path.join(resourcesDir, 'shardx-mcp');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'index.js'), '// mcp bridge', 'utf-8');
  fs.writeFileSync(path.join(d, 'package.json'), '{}', 'utf-8');
  return d;
}

test('isLauncherInstalled：未装返回 false', () => {
  const m = fresh();
  assert.strictEqual(m.isLauncherInstalled(), false);
  assert.strictEqual(m.getLauncherExePath(), null);
});

test('isLauncherInstalled：装好返回 true', () => {
  makeLauncherInstalled();
  const m = fresh();
  assert.strictEqual(m.isLauncherInstalled(), true);
  assert.ok(m.getLauncherExePath().endsWith('shardx-launcher.exe'));
});

test('installLauncher：已装直接返回 already', async () => {
  makeLauncherInstalled();
  const m = fresh();
  const r = await m.installLauncher();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.already, true);
  assert.strictEqual(execFileCalls.length, 0);
});

test('installLauncher：未装时用 /S 静默安装', async () => {
  fs.writeFileSync(path.join(resourcesDir, 'ShardX-setup.exe'), 'fake', 'utf-8');
  const m = fresh();
  const r = await m.installLauncher();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(execFileCalls.length, 1);
  assert.deepStrictEqual(execFileCalls[0].args, ['/S']);
});

test('installLauncher：缺 setup.exe 返回 ok:false 不抛', async () => {
  const m = fresh();
  // resourcesDir 为空 → 无 setup.exe
  const r = await m.installLauncher();
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

test('buildMcpServerConfig：无 settings 返回 null', () => {
  const m = fresh();
  assert.strictEqual(m.buildMcpServerConfig(), null);
});

test('buildMcpServerConfig：无 api_secret 返回 null', () => {
  writeSettings({ api_enabled: true, api_port: 40325 });
  const m = fresh();
  assert.strictEqual(m.buildMcpServerConfig(), null);
});

test('buildMcpServerConfig：生成三段 base64url JWT 与正确 env', () => {
  writeSettings({ api_secret: 'test-secret', api_port: 12345 });
  const m = fresh();
  const cfg = m.buildMcpServerConfig();
  assert.ok(cfg);
  assert.strictEqual(cfg.command, 'node');
  assert.ok(cfg.args[0].endsWith(path.join('shardx-mcp', 'index.js')));
  assert.strictEqual(cfg.env.SHARDX_API, 'http://127.0.0.1:12345');
  const parts = cfg.env.SHARDX_TOKEN.split('.');
  assert.strictEqual(parts.length, 3);
  for (const p of parts) {
    assert.ok(p.length > 0);
    assert.ok(!/[+/=]/.test(p), 'base64url 不应含 + / =');
  }
  // 解出 payload 校验
  const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
  assert.strictEqual(payload.sub, 'api');
  assert.ok(payload.exp > payload.iat);
});

test('buildMcpServerConfig：默认端口 40325', () => {
  writeSettings({ api_secret: 's' });
  const m = fresh();
  const cfg = m.buildMcpServerConfig();
  assert.strictEqual(cfg.env.SHARDX_API, 'http://127.0.0.1:40325');
});

test('ensureMcpAssets：从 resources 复制到 userData', () => {
  makeMcpSrc();
  const m = fresh();
  const r = m.ensureMcpAssets();
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(path.join(r.dir, 'index.js')));
  assert.ok(fs.existsSync(path.join(r.dir, 'package.json')));
});

test('ensureMcpAssets：幂等——已存在则不复制', () => {
  makeMcpSrc();
  const m = fresh();
  const r1 = m.ensureMcpAssets();
  assert.strictEqual(r1.ok, true);
  // 记录 mtime，再调一次
  const idx = path.join(r1.dir, 'index.js');
  const before = fs.statSync(idx).mtimeMs;
  // 改源文件内容，确认幂等不会覆盖
  fs.writeFileSync(path.join(resourcesDir, 'shardx-mcp', 'index.js'), '// changed', 'utf-8');
  const r2 = m.ensureMcpAssets();
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.dir, r1.dir);
  const after = fs.readFileSync(idx, 'utf-8');
  assert.strictEqual(after, '// mcp bridge', '幂等不应覆盖已存在文件');
});

test('ensureMcpAssets：源缺失返回 ok:false 不抛', () => {
  const m = fresh();
  const r = m.ensureMcpAssets();
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

test('ensureShardx：已装+有资产 → 汇总 ok', async () => {
  makeLauncherInstalled();
  makeMcpSrc();
  writeSettings({ api_secret: 's' });
  const m = fresh();
  const r = await m.ensureShardx();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.installed, true);
  assert.strictEqual(r.mcpReady, true);
});

test('ensureShardx：全失败也返回 ok:true（失败静默）', async () => {
  // 无 launcher、无 setup、无资产
  const m = fresh();
  const r = await m.ensureShardx();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.installed, false);
  assert.strictEqual(r.mcpReady, false);
});

test('startLauncher：未装返回 ok:false 不抛', async () => {
  const m = fresh();
  const r = await m.startLauncher();
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

test('getStatus：全未就位返回 installed/mcpReady=false', () => {
  const m = fresh();
  const s = m.getStatus();
  assert.strictEqual(s.installed, false);
  assert.strictEqual(s.mcpReady, false);
  assert.strictEqual(s.launcherExePath, null);
  assert.strictEqual(typeof s.mcpConfigured, 'boolean');
});

test('getStatus：装好 launcher + MCP 资产 → installed/mcpReady=true', () => {
  makeLauncherInstalled();
  // 就位 MCP 到 userData（getBaseDir 走 app.getPath('userData')=userDataDir）
  const m = fresh();
  m.ensureMcpAssets();
  makeMcpSrc();
  const m2 = fresh();
  m2.ensureMcpAssets();
  const s = m2.getStatus();
  assert.strictEqual(s.installed, true);
  assert.strictEqual(s.mcpReady, true);
  assert.ok(s.launcherExePath.endsWith('shardx-launcher.exe'));
});
