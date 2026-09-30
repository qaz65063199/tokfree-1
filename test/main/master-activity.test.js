'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const ma = require('../../src/main/team/master-activity');

beforeEach(() => { ma._reset(); });

test('从未注入时 msSinceInject 为 Infinity', () => {
  assert.strictEqual(ma.msSinceInject('p1'), Infinity);
});

test('noteInject 后可算出间隔', () => {
  ma.noteInject('p1');
  const ms = ma.msSinceInject('p1');
  assert.ok(ms >= 0 && ms < 1000);
});

test('isRecentlyInjected 默认 15s 内为 true', () => {
  ma.noteInject('p1');
  assert.strictEqual(ma.isRecentlyInjected('p1'), true);
  assert.strictEqual(ma.isRecentlyInjected('p1', 60000), true);
});

test('非法 profileId 不记录', () => {
  ma.noteInject(null);
  ma.noteInject('');
  ma.noteInject(123);
  assert.strictEqual(ma.msSinceInject(null), Infinity);
  assert.strictEqual(ma.msSinceInject(''), Infinity);
});

test('不同 profile 各自独立', () => {
  ma.noteInject('a');
  assert.ok(ma.msSinceInject('a') < 1000);
  assert.strictEqual(ma.msSinceInject('b'), Infinity);
});

test('_reset 清空', () => {
  ma.noteInject('x');
  ma._reset();
  assert.strictEqual(ma.msSinceInject('x'), Infinity);
});
