'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// 说明：本测试运行在无 DOM 的 Node 环境（不注入 global.document），
// 用于验证模块可加载、API 形状正确，以及无 DOM 时的优雅降级与参数容错。
const dialog = require('../../src/preload/overlay/dialog');

test('模块可 require，且导出 confirm / alert / prompt 三个函数', () => {
  assert.strictEqual(typeof dialog.confirm, 'function');
  assert.strictEqual(typeof dialog.alert, 'function');
  assert.strictEqual(typeof dialog.prompt, 'function');
});

test('三个 API 均返回 Promise', async () => {
  const a = dialog.confirm('确认吗？');
  const b = dialog.alert('提示');
  const c = dialog.prompt('请输入');
  assert.ok(a instanceof Promise);
  assert.ok(b instanceof Promise);
  assert.ok(c instanceof Promise);
  await Promise.all([a, b, c]);
});

test('无 DOM 时优雅降级：confirm→false / alert→undefined / prompt→null', async () => {
  assert.strictEqual(await dialog.confirm('要删除吗？'), false);
  assert.strictEqual(await dialog.alert('操作完成'), undefined);
  assert.strictEqual(await dialog.prompt('你的名字？'), null);
});

test('无效参数容错，不抛同步异常', async () => {
  await assert.doesNotReject(() => dialog.confirm(null, null));
  await assert.doesNotReject(() => dialog.alert(undefined, 'not-an-object'));
  await assert.doesNotReject(() => dialog.prompt({}, { title: 123 }));
  assert.strictEqual(await dialog.confirm(undefined, 42), false);
  assert.strictEqual(await dialog.alert(null, []), undefined);
  assert.strictEqual(await dialog.prompt(123, { defaultValue: null }), null);
});

test('传入完整 options 仍返回 Promise 且解析为约定值', async () => {
  const p = dialog.confirm('继续？', { title: '请确认', okText: '继续', cancelText: '算了' });
  assert.ok(p instanceof Promise);
  assert.strictEqual(await p, false);

  const q = dialog.prompt('文件名', { title: '新建', defaultValue: 'a.txt', placeholder: '请输入' });
  assert.ok(q instanceof Promise);
  assert.strictEqual(await q, null);
});
