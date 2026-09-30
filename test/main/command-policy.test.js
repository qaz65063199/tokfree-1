'use strict';
/**
 * command-policy.js 单元测试
 *
 * 依赖 electron 的 app.getPath('userData')，用 Module._load 钩子 mock electron，
 * 把 userData 指向临时目录（风格参照 test/main/tool-policy.test.js）。
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
  delete require.cache[require.resolve('../../src/main/command-policy')];
  return require('../../src/main/command-policy');
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-cmdpolicy-'));
  installMock();
});

afterEach(() => {
  uninstallMock();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
});

test('无规则时未命中', () => {
  const p = freshPolicy();
  const d = p.evaluateCommandPolicy('echo hi');
  assert.strictEqual(d.matched, false);
});

test('allow 规则：命中自动批准', () => {
  const p = freshPolicy();
  p.addRule({ pattern: '^npm test', action: 'allow' });
  const d = p.evaluateCommandPolicy('npm test');
  assert.strictEqual(d.matched, true);
  assert.strictEqual(d.action, 'allow');
});

test('allow 规则：命令含 shell 链接时降级为 confirm', () => {
  const p = freshPolicy();
  p.addRule({ pattern: '^npm', action: 'allow' });
  const d = p.evaluateCommandPolicy('npm test; rm -rf /');
  assert.strictEqual(d.action, 'confirm');
});

test('allow 规则：命令含管道时降级为 confirm', () => {
  const p = freshPolicy();
  p.addRule({ pattern: '^cat', action: 'allow' });
  const d = p.evaluateCommandPolicy('cat foo | rm');
  assert.strictEqual(d.action, 'confirm');
});

test('deny 优先于 allow', () => {
  const p = freshPolicy();
  p.addRule({ pattern: '^npm', action: 'allow' });
  p.addRule({ pattern: 'rm -rf', action: 'deny' });
  const d = p.evaluateCommandPolicy('npm test && rm -rf /');
  assert.strictEqual(d.action, 'deny');
});

test('deny 优先于 confirm', () => {
  const p = freshPolicy();
  p.addRule({ pattern: 'shutdown', action: 'confirm' });
  p.addRule({ pattern: 'shutdown -h', action: 'deny' });
  const d = p.evaluateCommandPolicy('shutdown -h now');
  assert.strictEqual(d.action, 'deny');
});

test('confirm 规则命中', () => {
  const p = freshPolicy();
  p.addRule({ pattern: '^git push', action: 'confirm' });
  const d = p.evaluateCommandPolicy('git push origin main');
  assert.strictEqual(d.action, 'confirm');
});

test('prefix 类型匹配（字面前缀，正则特殊字符被转义）', () => {
  const p = freshPolicy();
  p.addRule({ pattern: 'git push', type: 'prefix', action: 'confirm' });
  assert.strictEqual(p.evaluateCommandPolicy('git push').action, 'confirm');
  // "." 在 prefix 下是字面点，不匹配任意字符
  p.addRule({ pattern: 'a.b', type: 'prefix', action: 'allow' });
  assert.strictEqual(p.evaluateCommandPolicy('a.b').action, 'allow');
  assert.strictEqual(p.evaluateCommandPolicy('axb').matched, false);
});

test('addRule 拒绝非法 action', () => {
  const p = freshPolicy();
  assert.throws(() => p.addRule({ pattern: 'x', action: 'bogus' }), /action/);
});

test('addRule 拒绝非法正则', () => {
  const p = freshPolicy();
  assert.throws(() => p.addRule({ pattern: '(', action: 'allow' }), /编译/);
});

test('addRule 拒绝空 pattern', () => {
  const p = freshPolicy();
  assert.throws(() => p.addRule({ pattern: '', action: 'allow' }), /pattern/);
});

test('removeRule 删除规则', () => {
  const p = freshPolicy();
  const r = p.addRule({ pattern: '^ls', action: 'allow' });
  assert.strictEqual(p.removeRule(r.id), true);
  assert.strictEqual(p.evaluateCommandPolicy('ls').matched, false);
  assert.strictEqual(p.removeRule('不存在'), false);
});

test('setRules 整体替换并校验', () => {
  const p = freshPolicy();
  p.setRules([{ pattern: '^echo', action: 'allow' }]);
  assert.strictEqual(p.evaluateCommandPolicy('echo hi').action, 'allow');
  assert.throws(() => p.setRules([{ pattern: '^x', action: 'bad' }]), /action/);
});

test('配置持久化（新实例可见）', () => {
  const p = freshPolicy();
  p.addRule({ pattern: '^docker', action: 'allow' });
  const p2 = freshPolicy();
  assert.strictEqual(p2.evaluateCommandPolicy('docker ps').action, 'allow');
});

test('getConfig 返回内置规则视图 + 用户规则', () => {
  const p = freshPolicy();
  p.addRule({ pattern: '^ls', action: 'allow' });
  const cfg = p.getConfig();
  assert.ok(Array.isArray(cfg.builtinRules));
  assert.ok(cfg.builtinRules.length >= 9);
  assert.strictEqual(cfg.rules.length, 1);
});

test('存储文件损坏时容错并备份', () => {
  fs.writeFileSync(path.join(userDataDir, 'command-policy.json'), '{ bad json', 'utf-8');
  const p = freshPolicy();
  assert.strictEqual(p.evaluateCommandPolicy('echo hi').matched, false);
  const files = fs.readdirSync(userDataDir);
  assert.ok(files.some((f) => f.includes('.corrupt-')), '应备份损坏文件');
});
