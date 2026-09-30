'use strict';
/**
 * evolution-switch 单元测试（node:test 风格）
 * 覆盖：默认关、setEnabled/isEnabled 往返、getConfig 结构、配置文件损坏容错。
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const evo = require('../../src/main/team/evolution-switch');

let dir;
let cfgFile;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-switch-'));
  cfgFile = path.join(dir, 'evolution-config.json');
  evo._reset();
  evo._setConfigFile(cfgFile);
});
afterEach(() => {
  try { evo._reset(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
});

test('默认关闭（enabled=false）', () => {
  assert.strictEqual(evo.isEnabled(), false);
  assert.deepStrictEqual(evo.getConfig(), { enabled: false });
});

test('setEnabled(true) 后 isEnabled 为 true，且持久化到磁盘', () => {
  const r = evo.setEnabled(true);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(evo.isEnabled(), true);
  assert.ok(fs.existsSync(cfgFile));
  const obj = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.deepStrictEqual(obj, { enabled: true });
});

test('setEnabled(false) 可再次关闭', () => {
  evo.setEnabled(true);
  evo.setEnabled(false);
  assert.strictEqual(evo.isEnabled(), false);
});

test('非布尔值按 false 处理', () => {
  evo.setEnabled('yes');
  assert.strictEqual(evo.isEnabled(), false);
  evo.setEnabled(1);
  assert.strictEqual(evo.isEnabled(), false);
});

test('配置文件损坏时降级为默认关，不抛异常', () => {
  fs.writeFileSync(cfgFile, '{ not valid json', 'utf8');
  evo._reset();
  evo._setConfigFile(cfgFile);
  assert.doesNotThrow(() => evo.isEnabled());
  assert.strictEqual(evo.isEnabled(), false);
});
