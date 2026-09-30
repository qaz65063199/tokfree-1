'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { JsRunner } = require('../../tools/JsRunner');
const { registry } = require('../../tools');

test('JsRunner 执行简单 JS 代码', async () => {
  const runner = new JsRunner(registry);
  const r = await runner.run('const x = 1 + 2; log(x);', process.cwd());
  assert.strictEqual(r.success, true);
  assert.ok(r.output.includes('3'));
});

test('JsRunner 空代码报错', async () => {
  const runner = new JsRunner(registry);
  const r = await runner.run('', null);
  assert.strictEqual(r.success, false);
  assert.match(r.error, /无效的 JS 代码/);
});

test('JsRunner null 代码报错', async () => {
  const runner = new JsRunner(registry);
  const r = await runner.run(null, null);
  assert.strictEqual(r.success, false);
});

test('JsRunner 语法错误返回失败', async () => {
  const runner = new JsRunner(registry);
  let r;
  try { r = await runner.run('const = ;', process.cwd()); } catch (e) { r = { success: false, error: e.message }; }
  assert.strictEqual(r.success, false);
  assert.ok(r.error);
});

test('JsRunner 调用 read 工具', async () => {
  const runner = new JsRunner(registry);
  const r = await runner.run('const c = await read("package.json"); log(c.slice(0, 20));', process.cwd());
  assert.strictEqual(r.success, true);
  assert.ok(r.output.length > 0);
});

test('JsRunner 未知工具报错', async () => {
  const runner = new JsRunner(registry);
  const r = await runner.run('await read("a.txt")', null);
  assert.strictEqual(r.success, false);
  assert.ok(r.error);
});

test('JsRunner 支持 await sleep(ms)', async () => {
  const runner = new JsRunner(registry);
  const start = Date.now();
  const r = await runner.run('await sleep(50); log("slept");', process.cwd());
  assert.strictEqual(r.success, true);
  assert.ok(r.output.includes('slept'));
  assert.ok(Date.now() - start >= 40, '应至少等待约 50ms');
});

test('JsRunner 支持 new Promise + setTimeout', async () => {
  const runner = new JsRunner(registry);
  const r = await runner.run(
    'await new Promise((res) => setTimeout(res, 30)); log("done");',
    process.cwd()
  );
  assert.strictEqual(r.success, true);
  assert.ok(r.output.includes('done'));
});

test('JsRunner sleep 非法入参按 0 处理', async () => {
  const runner = new JsRunner(registry);
  const r = await runner.run('await sleep("abc"); log("ok");', process.cwd());
  assert.strictEqual(r.success, true);
  assert.ok(r.output.includes('ok'));
});

test('JsRunner sleep 超上限被钳制', async () => {
  const runner = new JsRunner(registry);
  // 传入负值 → 钳制为 0，不应抛错
  const r = await runner.run('await sleep(-100); log("neg");', process.cwd());
  assert.strictEqual(r.success, true);
  assert.ok(r.output.includes('neg'));
});
