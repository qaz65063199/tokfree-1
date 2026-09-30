'use strict';
/**
 * mcp-config.ensureShardxServer 单元测试
 *
 * 核心：只在不存在或本应用生成（env.TOKFREE_MANAGED）时写入；
 * 用户手动配置的 shardx 一律保留不覆盖。
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const origLoad = Module._load;
let userDataDir;

function installMock() {
  Module._load = function (request) {
    if (request === 'electron') {
      return { app: { getPath: () => userDataDir, isPackaged: false } };
    }
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() { Module._load = origLoad; }

function fresh() {
  delete require.cache[require.resolve('../../src/main/mcp-config')];
  return require('../../src/main/mcp-config');
}

function readJson() {
  return JSON.parse(fs.readFileSync(path.join(userDataDir, 'mcp.json'), 'utf-8'));
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-mcpc-'));
  installMock();
});
afterEach(() => {
  uninstallMock();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
});

const build = () => ({ command: 'node', args: ['/x/shardx-mcp/index.js'], env: { SHARDX_API: 'http://127.0.0.1:40325', SHARDX_TOKEN: 'tok' } });

test('不存在时写入并带 TOKFREE_MANAGED 标记', () => {
  const m = fresh();
  const r = m.ensureShardxServer(build);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.updated, true);
  const cfg = readJson();
  assert.ok(cfg.mcpServers.shardx);
  assert.strictEqual(cfg.mcpServers.shardx.command, 'node');
  assert.strictEqual(cfg.mcpServers.shardx.env.TOKFREE_MANAGED, '1');
});

test('已存在且内容相同 → unchanged，不重写', () => {
  const m = fresh();
  m.ensureShardxServer(build);
  const r2 = m.ensureShardxServer(build);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.updated, false);
  assert.strictEqual(r2.reason, 'unchanged');
});

test('用户手动配置（无 MANAGED 标记）→ 保留不覆盖', () => {
  const m = fresh();
  // 先写一个用户自定义的 shardx（无 MANAGED 标记）
  fs.writeFileSync(path.join(userDataDir, 'mcp.json'), JSON.stringify({
    mcpServers: { shardx: { command: 'npx', args: ['my-shardx'] } },
  }), 'utf-8');
  const r = m.ensureShardxServer(build);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.updated, false);
  assert.strictEqual(r.reason, 'user-config-preserved');
  const cfg = readJson();
  assert.strictEqual(cfg.mcpServers.shardx.command, 'npx', '用户配置不应被覆盖');
});

test('本应用先前生成（带 MANAGED）→ 可更新', () => {
  const m = fresh();
  m.ensureShardxServer(build);
  // 改内容（模拟新 JWT / 端口变化）
  const r2 = m.ensureShardxServer(() => ({ command: 'node', args: ['/x/shardx-mcp/index.js'], env: { SHARDX_API: 'http://127.0.0.1:9999', SHARDX_TOKEN: 'tok2' } }));
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.updated, true);
  const cfg = readJson();
  assert.strictEqual(cfg.mcpServers.shardx.env.SHARDX_API, 'http://127.0.0.1:9999');
});

test('buildConfig 返回 null → no-config，不写', () => {
  const m = fresh();
  const r = m.ensureShardxServer(() => null);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.updated, false);
  assert.strictEqual(r.reason, 'no-config');
});
