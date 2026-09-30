'use strict';
/**
 * tool-policy.js 单元测试
 *
 * 依赖 electron 的 app.getPath('userData') 定位存储目录。
 * 参照 test/main/knowledge.test.js，用 Module._load 钩子 mock electron，
 * 把 userData 指向临时目录，隔离文件系统副作用。
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
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath: (name) => (name === 'userData' ? userDataDir : userDataDir),
          setPath: () => {},
        },
      };
    }
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() {
  Module._load = origLoad;
}

function freshPolicy() {
  delete require.cache[require.resolve('../../src/main/tool-policy')];
  return require('../../src/main/tool-policy');
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-policy-'));
  installMock();
});

afterEach(() => {
  uninstallMock();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
});

test('默认策略：mode=act、confirmDangerous=true', () => {
  const p = freshPolicy();
  const pol = p.getPolicy('p1');
  assert.strictEqual(pol.mode, 'act');
  assert.strictEqual(pol.confirmDangerous, true);
});

test('Plan 模式阻止 write 工具', () => {
  const p = freshPolicy();
  p.setMode('plan', 'p1');
  const d = p.checkPolicy('p1', 'write', {});
  assert.strictEqual(d.action, 'block');
  assert.strictEqual(d.mode, 'plan');
  assert.ok(d.reason.includes('Plan'));
});

test('Plan 模式阻止 exec 工具', () => {
  const p = freshPolicy();
  p.setMode('plan', 'p1');
  assert.strictEqual(p.checkPolicy('p1', 'bash', { command: 'echo hi' }).action, 'block');
  assert.strictEqual(p.checkPolicy('p1', 'pwsh', { command: 'echo hi' }).action, 'block');
  assert.strictEqual(p.checkPolicy('p1', 'inject_js', {}).action, 'block');
});

test('Plan 模式允许 read 工具', () => {
  const p = freshPolicy();
  p.setMode('plan', 'p1');
  assert.strictEqual(p.checkPolicy('p1', 'read', {}).action, 'allow');
  assert.strictEqual(p.checkPolicy('p1', 'grep', {}).action, 'allow');
  assert.strictEqual(p.checkPolicy('p1', 'web_fetch', {}).action, 'allow');
  assert.strictEqual(p.checkPolicy('p1', 'todo_write', {}).action, 'allow');
});

test('Plan 模式允许通配 read 工具（watchdog_*/team_get_*）', () => {
  const p = freshPolicy();
  p.setMode('plan', 'p1');
  assert.strictEqual(p.checkPolicy('p1', 'watchdog_status', {}).action, 'allow');
  assert.strictEqual(p.checkPolicy('p1', 'team_get_progress', {}).action, 'allow');
});

test('Act 模式允许 write 工具', () => {
  const p = freshPolicy();
  assert.strictEqual(p.checkPolicy('p1', 'write', {}).action, 'allow');
  assert.strictEqual(p.checkPolicy('p1', 'edit', {}).action, 'allow');
});

test('Act 模式允许普通 bash 命令', () => {
  const p = freshPolicy();
  const d = p.checkPolicy('p1', 'bash', { command: 'npm test' });
  assert.strictEqual(d.action, 'allow');
  assert.strictEqual(d.mode, 'act');
});

test('Act 模式危险命令触发 confirm', () => {
  const p = freshPolicy();
  const d = p.checkPolicy('p1', 'bash', { command: 'rm -rf /' });
  assert.strictEqual(d.action, 'confirm');
  assert.ok(d.reason.length > 0);
});

test('Act 模式 pwsh 危险命令触发 confirm', () => {
  const p = freshPolicy();
  const d = p.checkPolicy('p1', 'pwsh', { command: 'shutdown /s' });
  assert.strictEqual(d.action, 'confirm');
});

test('信任模式（confirmDangerous=false）危险命令放行', () => {
  const p = freshPolicy();
  p.setConfirmDangerous(false, 'p1');
  const d = p.checkPolicy('p1', 'bash', { command: 'rm -rf /' });
  assert.strictEqual(d.action, 'allow');
});

test('file_delete 触发 confirm', () => {
  const p = freshPolicy();
  const d = p.checkPolicy('p1', 'file_delete', { file_path: 'a.txt' });
  assert.strictEqual(d.action, 'confirm');
});

test('信任模式下 file_delete 放行', () => {
  const p = freshPolicy();
  p.setConfirmDangerous(false, 'p1');
  assert.strictEqual(p.checkPolicy('p1', 'file_delete', {}).action, 'allow');
});

test('classifyTool：read 类', () => {
  const p = freshPolicy();
  assert.strictEqual(p.classifyTool('read'), 'read');
  assert.strictEqual(p.classifyTool('grep'), 'read');
  assert.strictEqual(p.classifyTool('web_fetch'), 'read');
});

test('classifyTool：write 类', () => {
  const p = freshPolicy();
  assert.strictEqual(p.classifyTool('write'), 'write');
  assert.strictEqual(p.classifyTool('edit'), 'write');
  assert.strictEqual(p.classifyTool('file_delete'), 'write');
});

test('classifyTool：exec 类', () => {
  const p = freshPolicy();
  assert.strictEqual(p.classifyTool('bash'), 'exec');
  assert.strictEqual(p.classifyTool('pwsh'), 'exec');
  assert.strictEqual(p.classifyTool('inject_js'), 'exec');
});

test('classifyTool：未列出默认 write', () => {
  const p = freshPolicy();
  assert.strictEqual(p.classifyTool('some_unknown_tool'), 'write');
});

test('setMode 返回新 mode 并持久化', () => {
  const p = freshPolicy();
  assert.strictEqual(p.setMode('plan', 'p1'), 'plan');
  // 重新加载（新实例）验证持久化
  const p2 = freshPolicy();
  assert.strictEqual(p2.getPolicy('p1').mode, 'plan');
});

test('setConfirmDangerous 返回新值并持久化', () => {
  const p = freshPolicy();
  assert.strictEqual(p.setConfirmDangerous(false, 'p1'), false);
  const p2 = freshPolicy();
  assert.strictEqual(p2.getPolicy('p1').confirmDangerous, false);
});

test('不同 profileId 互不影响', () => {
  const p = freshPolicy();
  p.setMode('plan', 'p1');
  p.setMode('act', 'p2');
  assert.strictEqual(p.getPolicy('p1').mode, 'plan');
  assert.strictEqual(p.getPolicy('p2').mode, 'act');
});

test('存储文件损坏时容错并备份', () => {
  fs.writeFileSync(path.join(userDataDir, 'tool-policy.json'), '{ bad json', 'utf-8');
  const p = freshPolicy();
  const pol = p.getPolicy('p1');
  assert.strictEqual(pol.mode, 'act');
  assert.strictEqual(pol.confirmDangerous, true);
  // 应生成 .corrupt- 备份
  const files = fs.readdirSync(userDataDir);
  assert.ok(files.some(f => f.includes('.corrupt-')), '应备份损坏文件');
});

test('setMode 非法值回退为 act', () => {
  const p = freshPolicy();
  assert.strictEqual(p.setMode('bogus', 'p1'), 'act');
});

// ===== 全局默认 + 标签覆盖 =====

test('setGlobalTrust 影响未单独覆盖的标签', () => {
  const p = freshPolicy();
  p.setGlobalTrust(false); // 全局：免确认
  assert.strictEqual(p.getPolicy('p1').confirmDangerous, false);
  assert.strictEqual(p.checkPolicy('p1', 'bash', { command: 'rm -rf /' }).action, 'allow');
  assert.strictEqual(p.checkPolicy('p2', 'file_delete', {}).action, 'allow');
});

test('setGlobalMode 影响未单独覆盖的标签', () => {
  const p = freshPolicy();
  p.setGlobalMode('plan');
  assert.strictEqual(p.getPolicy('p1').mode, 'plan');
  assert.strictEqual(p.checkPolicy('p1', 'write', {}).action, 'block');
});

test('标签覆盖优先于全局默认', () => {
  const p = freshPolicy();
  p.setGlobalTrust(false);           // 全局免确认
  p.setConfirmDangerous(true, 'p1'); // p1 覆盖：需确认
  assert.strictEqual(p.getPolicy('p1').confirmDangerous, true);
  assert.strictEqual(p.getPolicy('p2').confirmDangerous, false);
  assert.strictEqual(p.checkPolicy('p1', 'file_delete', {}).action, 'confirm');
  assert.strictEqual(p.checkPolicy('p2', 'file_delete', {}).action, 'allow');
});

test('模式全局与覆盖独立回退', () => {
  const p = freshPolicy();
  p.setGlobalMode('plan');
  p.setMode('act', 'p1'); // p1 覆盖模式，但信任仍回退全局
  assert.strictEqual(p.getPolicy('p1').mode, 'act');
  assert.strictEqual(p.getPolicy('p2').mode, 'plan');
});

test('无 __global__ 老数据仍按原语义工作（向后兼容）', () => {
  fs.writeFileSync(path.join(userDataDir, 'tool-policy.json'),
    JSON.stringify({ p1: { mode: 'plan', confirmDangerous: false } }), 'utf-8');
  const p = freshPolicy();
  assert.strictEqual(p.getPolicy('p1').mode, 'plan');
  assert.strictEqual(p.getPolicy('p1').confirmDangerous, false);
  // 无覆盖的标签回退 DEFAULT
  assert.strictEqual(p.getPolicy('p2').mode, 'act');
  assert.strictEqual(p.getPolicy('p2').confirmDangerous, true);
});

test('全局设置持久化', () => {
  const p = freshPolicy();
  p.setGlobalTrust(false);
  p.setGlobalMode('plan');
  const p2 = freshPolicy();
  assert.strictEqual(p2.getPolicy('pX').confirmDangerous, false);
  assert.strictEqual(p2.getPolicy('pX').mode, 'plan');
});

// ===== 命令策略（command-policy）集成 =====
function freshCommandPolicy() {
  delete require.cache[require.resolve('../../src/main/command-policy')];
  return require('../../src/main/command-policy');
}

test('命令策略 deny 规则 → checkPolicy 返回 block', () => {
  const cp = freshCommandPolicy();
  cp.addRule({ pattern: 'rm -rf', action: 'deny' });
  const p = freshPolicy();
  const d = p.checkPolicy('p1', 'bash', { command: 'echo hi && rm -rf /' });
  assert.strictEqual(d.action, 'block');
  assert.ok(d.reason.includes('deny'));
});

test('命令策略 allow 规则 → checkPolicy 返回 allow（即便命中内置黑名单）', () => {
  const cp = freshCommandPolicy();
  // shutdown 在内置黑名单中，但用户显式 allow
  cp.addRule({ pattern: '^shutdown /r /t 0', action: 'allow' });
  const p = freshPolicy();
  const d = p.checkPolicy('p1', 'bash', { command: 'shutdown /r /t 0' });
  assert.strictEqual(d.action, 'allow');
});

test('命令策略 confirm 规则 → checkPolicy 返回 confirm', () => {
  const cp = freshCommandPolicy();
  cp.addRule({ pattern: '^git push', action: 'confirm' });
  const p = freshPolicy();
  const d = p.checkPolicy('p1', 'bash', { command: 'git push origin main' });
  assert.strictEqual(d.action, 'confirm');
});

test('无用户规则时回退内置黑名单（向后兼容）', () => {
  const p = freshPolicy();
  const d = p.checkPolicy('p1', 'bash', { command: 'rm -rf /' });
  assert.strictEqual(d.action, 'confirm');
});

test('无用户规则时普通命令仍放行', () => {
  const p = freshPolicy();
  assert.strictEqual(p.checkPolicy('p1', 'bash', { command: 'npm test' }).action, 'allow');
});
