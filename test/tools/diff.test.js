'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createUnifiedDiff, diffOps, splitLines } = require('../../tools/diff');

test('splitLines 空输入安全', () => {
  assert.deepStrictEqual(splitLines(''), []);
  assert.deepStrictEqual(splitLines(null), []);
  assert.deepStrictEqual(splitLines(undefined), []);
});

test('splitLines 支持 CRLF 与 LF', () => {
  assert.deepStrictEqual(splitLines('a\nb'), ['a', 'b']);
  assert.deepStrictEqual(splitLines('a\r\nb'), ['a', 'b']);
});

test('createUnifiedDiff 无变化返回 changed=false', () => {
  const r = createUnifiedDiff('a\nb', 'a\nb');
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.added, 0);
  assert.strictEqual(r.removed, 0);
  assert.strictEqual(r.diff, '');
});

test('createUnifiedDiff 单行替换', () => {
  const r = createUnifiedDiff('hello world', 'hello tokfree', { filePath: 'a.txt' });
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.added, 1);
  assert.strictEqual(r.removed, 1);
  assert.match(r.diff, /--- a.txt \(old\)/);
  assert.match(r.diff, /\+\+\+ a.txt \(new\)/);
  assert.match(r.diff, /-hello world/);
  assert.match(r.diff, /\+hello tokfree/);
});

test('createUnifiedDiff 纯新增', () => {
  const r = createUnifiedDiff('', 'a\nb');
  assert.strictEqual(r.added, 2);
  assert.strictEqual(r.removed, 0);
  assert.match(r.diff, /\+a/);
  assert.match(r.diff, /\+b/);
});

test('createUnifiedDiff 纯删除', () => {
  const r = createUnifiedDiff('a\nb', '');
  assert.strictEqual(r.added, 0);
  assert.strictEqual(r.removed, 2);
  assert.match(r.diff, /-a/);
});

test('createUnifiedDiff 上下文行保留', () => {
  const old = ['1', '2', '3', '4', '5'].join('\n');
  const neu = ['1', '2', 'X', '4', '5'].join('\n');
  const r = createUnifiedDiff(old, neu, { context: 1 });
  assert.match(r.diff, / 2/);
  assert.match(r.diff, /-3/);
  assert.match(r.diff, /\+X/);
  assert.match(r.diff, / 4/);
});

test('diffOps 返回 equal/del/add 序列', () => {
  const ops = diffOps(['a', 'b'], ['a', 'c']);
  assert.strictEqual(ops[0].type, 'equal');
  assert.ok(ops.some((o) => o.type === 'del' && o.text === 'b'));
  assert.ok(ops.some((o) => o.type === 'add' && o.text === 'c'));
});

test('createUnifiedDiff 大文件整块替换不抛错', () => {
  const big = new Array(6000).fill('x').join('\n');
  const r = createUnifiedDiff(big, 'y');
  assert.strictEqual(r.changed, true);
});
