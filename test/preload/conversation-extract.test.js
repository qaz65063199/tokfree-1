'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { summarizeToolCode, isReceiptText } = require('../../src/preload/dom/conversation-extract');

test('summarizeToolCode 提取单个工具调用', () => {
  const code = 'const c = await read("package.json");\nlog(c);';
  const steps = summarizeToolCode(code);
  const names = steps.map(s => s.name);
  assert.ok(names.includes('read'));
  const r = steps.find(s => s.name === 'read');
  assert.strictEqual(r.label, '读取文件');
  assert.strictEqual(r.arg, 'package.json');
});

test('summarizeToolCode 多个调用按序提取', () => {
  const code = [
    'await bash("npm test");',
    'await edit("src/a.js", "old", "new");',
    'await write("docs/out.md", `内容`);',
  ].join('\n');
  const steps = summarizeToolCode(code);
  assert.deepStrictEqual(steps.map(s => s.name), ['bash', 'edit', 'write']);
  assert.strictEqual(steps[0].arg, 'npm test');
  assert.strictEqual(steps[1].arg, 'src/a.js');
  assert.strictEqual(steps[2].arg, 'docs/out.md');
});

test('summarizeToolCode 反引号多行参数折叠为一行并截断', () => {
  const long = 'y'.repeat(200);
  const code = 'await write("a.txt", `' + long + '`);';
  const steps = summarizeToolCode(code);
  assert.strictEqual(steps.length, 1);
  // 参数上限 200 字符（正则限制）后再截断到 60 + …
  assert.ok(steps[0].arg.length <= 61);
});

test('summarizeToolCode 忽略未知函数名', () => {
  const code = 'await foo("x");\nconsole.log("y");\nawait read("b.js");';
  const steps = summarizeToolCode(code);
  assert.deepStrictEqual(steps.map(s => s.name), ['read']);
});

test('summarizeToolCode 空输入/非字符串安全返回空数组', () => {
  assert.deepStrictEqual(summarizeToolCode(''), []);
  assert.deepStrictEqual(summarizeToolCode(null), []);
  assert.deepStrictEqual(summarizeToolCode(undefined), []);
  assert.deepStrictEqual(summarizeToolCode(42), []);
});

test('summarizeToolCode 对象成员调用不计入（避免误报 x.read()）', () => {
  const code = 'await fs.read("c.js");';
  const steps = summarizeToolCode(code);
  assert.deepStrictEqual(steps, []);
});

test('isReceiptText 识别两种回执前缀', () => {
  assert.strictEqual(isReceiptText('【JS 执行结果汇总】(共 1 个脚本)'), true);
  assert.strictEqual(isReceiptText('【工具执行结果】read 执行成功'), true);
  assert.strictEqual(isReceiptText('普通用户消息'), false);
  assert.strictEqual(isReceiptText('前缀不在开头【JS 执行结果汇总】'), false);
  assert.strictEqual(isReceiptText(''), false);
  assert.strictEqual(isReceiptText(null), false);
});
