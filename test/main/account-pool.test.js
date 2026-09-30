'use strict';
/**
 * account-pool.js 单元测试
 *
 * 依赖 electron 的 app.getPath('userData') 与 safeStorage。
 * 用 Module._load 钩子 mock electron，把 userData 指向临时目录，
 * 并用可逆的假加密实现替代 safeStorage（参考 tool-policy.test.js）。
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const origLoad = Module._load;
let userDataDir;
let encAvailable = true;

function installMock() {
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath: (name) => (name === 'userData' ? userDataDir : userDataDir),
          setPath: () => {},
        },
        safeStorage: {
          isEncryptionAvailable: () => encAvailable,
          // 可逆的假加密：Buffer('enc::' + plain)
          encryptString: (s) => Buffer.from('enc::' + s, 'utf-8'),
          decryptString: (buf) => buf.toString('utf-8').replace(/^enc::/, ''),
        },
      };
    }
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() {
  Module._load = origLoad;
}

function freshPool() {
  delete require.cache[require.resolve('../../src/main/account-pool')];
  return require('../../src/main/account-pool');
}

function readStoreFile() {
  return fs.readFileSync(path.join(userDataDir, 'account-pool.json'), 'utf-8');
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokfree-acct-'));
  encAvailable = true;
  installMock();
});

afterEach(() => {
  uninstallMock();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
});

test('createAccount 返回 success 与 acc- 前缀 id', () => {
  const p = freshPool();
  const r = p.createAccount({ providerId: 'deepseek', username: 'u@mail.com', password: 'pw' });
  assert.strictEqual(r.success, true);
  assert.ok(r.id.startsWith('acc-'));
});

test('createAccount 缺少 providerId / username 报错', () => {
  const p = freshPool();
  assert.strictEqual(p.createAccount({ username: 'u' }).success, false);
  assert.strictEqual(p.createAccount({ providerId: 'deepseek' }).success, false);
});

test('listAccounts 不含密码、含 hasPassword', () => {
  const p = freshPool();
  p.createAccount({ providerId: 'deepseek', username: 'u@mail.com', password: 'SuperSecret!Pw' });
  const list = p.listAccounts();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].password, undefined);
  assert.strictEqual(list[0].passwordEnc, undefined);
  assert.strictEqual(list[0].hasPassword, true);
});

test('listAccounts 按 providerId 过滤', () => {
  const p = freshPool();
  p.createAccount({ providerId: 'deepseek', username: 'a', password: 'x' });
  p.createAccount({ providerId: 'claude', username: 'b', password: 'y' });
  assert.strictEqual(p.listAccounts().length, 2);
  assert.strictEqual(p.listAccounts('deepseek').length, 1);
  assert.strictEqual(p.listAccounts('deepseek')[0].username, 'a');
});

test('getAccount 不含密码，hasPassword 正确', () => {
  const p = freshPool();
  const r = p.createAccount({ providerId: 'deepseek', username: 'u', password: 'pw' });
  const acc = p.getAccount(r.id);
  assert.strictEqual(acc.username, 'u');
  assert.strictEqual(acc.hasPassword, true);
  assert.strictEqual(acc.password, undefined);
});

test('getAccount 不存在返回 null', () => {
  const p = freshPool();
  assert.strictEqual(p.getAccount('nope'), null);
});

test('getAccountWithPassword 返回明文密码', () => {
  const p = freshPool();
  const r = p.createAccount({ providerId: 'deepseek', username: 'u', password: 'SuperSecret!Pw' });
  const acc = p.getAccountWithPassword(r.id);
  assert.strictEqual(acc.password, 'SuperSecret!Pw');
});

test('密码加密存储：文件中不含明文密码', () => {
  const p = freshPool();
  p.createAccount({ providerId: 'deepseek', username: 'u', password: 'SuperSecret!Pw' });
  const raw = readStoreFile();
  assert.ok(!raw.includes('SuperSecret!Pw'), '文件不得含明文密码');
  assert.ok(raw.includes('passwordEnc'), '应有 passwordEnc 字段');
});

test('无密码创建：hasPassword=false', () => {
  const p = freshPool();
  const r = p.createAccount({ providerId: 'deepseek', username: 'u' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(p.getAccount(r.id).hasPassword, false);
  assert.strictEqual(p.getAccountWithPassword(r.id).password, '');
});

test('safeStorage 不可用：不保存密码并返回 warning', () => {
  encAvailable = false;
  const p = freshPool();
  const r = p.createAccount({ providerId: 'deepseek', username: 'u', password: 'SuperSecret!Pw' });
  assert.strictEqual(r.success, true);
  assert.ok(r.warning, '应返回 warning');
  assert.strictEqual(p.getAccount(r.id).hasPassword, false);
  const raw = readStoreFile();
  assert.ok(!raw.includes('SuperSecret!Pw'), '降级时也不得存明文');
});

test('updateAccount 更新普通字段', () => {
  const p = freshPool();
  const r = p.createAccount({ providerId: 'deepseek', username: 'u', password: 'pw' });
  const up = p.updateAccount(r.id, { label: '账号A', note: 'hello' });
  assert.strictEqual(up.success, true);
  const acc = p.getAccount(r.id);
  assert.strictEqual(acc.label, '账号A');
  assert.strictEqual(acc.note, 'hello');
});

test('updateAccount 传 password 重新加密', () => {
  const p = freshPool();
  const r = p.createAccount({ providerId: 'deepseek', username: 'u', password: 'oldPw' });
  p.updateAccount(r.id, { password: 'NewSecret!Pw' });
  assert.strictEqual(p.getAccountWithPassword(r.id).password, 'NewSecret!Pw');
  assert.ok(!readStoreFile().includes('NewSecret!Pw'), '新密码不得明文');
});

test('updateAccount 不存在的 id 报错', () => {
  const p = freshPool();
  assert.strictEqual(p.updateAccount('nope', { label: 'x' }).success, false);
});

test('deleteAccount 删除账号', () => {
  const p = freshPool();
  const r = p.createAccount({ providerId: 'deepseek', username: 'u', password: 'pw' });
  assert.strictEqual(p.deleteAccount(r.id).success, true);
  assert.strictEqual(p.getAccount(r.id), null);
  assert.strictEqual(p.listAccounts().length, 0);
});

test('deleteAccount 不存在的 id 报错', () => {
  const p = freshPool();
  assert.strictEqual(p.deleteAccount('nope').success, false);
});

test('markUsed 更新 lastUsed', () => {
  const p = freshPool();
  const r = p.createAccount({ providerId: 'deepseek', username: 'u', password: 'pw' });
  assert.strictEqual(p.getAccount(r.id).lastUsed, null);
  const m = p.markUsed(r.id);
  assert.strictEqual(m.success, true);
  assert.ok(p.getAccount(r.id).lastUsed, 'lastUsed 应被写入');
});

test('损坏 JSON 容错并备份', () => {
  fs.writeFileSync(path.join(userDataDir, 'account-pool.json'), '{ bad json', 'utf-8');
  const p = freshPool();
  assert.deepStrictEqual(p.listAccounts(), []);
  const files = fs.readdirSync(userDataDir);
  assert.ok(files.some(f => f.includes('.corrupt-')), '应备份损坏文件');
});

test('结构异常容错并备份', () => {
  fs.writeFileSync(path.join(userDataDir, 'account-pool.json'), JSON.stringify({ accounts: 'nope' }), 'utf-8');
  const p = freshPool();
  assert.deepStrictEqual(p.listAccounts(), []);
  const files = fs.readdirSync(userDataDir);
  assert.ok(files.some(f => f.includes('.corrupt-')), '结构非法应备份');
});

test('持久化：新实例可读到已有账号', () => {
  const p = freshPool();
  const r = p.createAccount({ providerId: 'deepseek', username: 'u', password: 'pw' });
  const p2 = freshPool();
  assert.strictEqual(p2.getAccount(r.id).username, 'u');
});
