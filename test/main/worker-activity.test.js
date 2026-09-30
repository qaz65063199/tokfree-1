'use strict';
/**
 * worker-activity.js 单元测试
 *
 * 纯内存模块，无外部依赖（不依赖 electron），直接 require 即可。
 * 每个测试前用 _reset() 清空状态，避免用例间相互影响。
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const wa = require('../../src/main/worker-activity');

beforeEach(() => {
  wa._reset();
});

test('touch 后 getLastActivity 返回时间戳', () => {
  const before = Date.now();
  wa.touch('p1');
  const ts = wa.getLastActivity('p1');
  assert.ok(typeof ts === 'number');
  assert.ok(ts >= before && ts <= Date.now());
});

test('从未活动时 getLastActivity 返回 null', () => {
  assert.strictEqual(wa.getLastActivity('never'), null);
});

test('从未活动时 getAgoSeconds 返回 null', () => {
  assert.strictEqual(wa.getAgoSeconds('never'), null);
});

test('touch 后 getAgoSeconds 返回接近 0 的秒数', () => {
  wa.touch('p2');
  const ago = wa.getAgoSeconds('p2');
  assert.strictEqual(typeof ago, 'number');
  assert.ok(ago >= 0 && ago <= 1);
});

test('多次 touch 更新为最新时间（ago 覆盖旧值）', () => {
  wa.touch('p3');
  const first = wa.getLastActivity('p3');
  // 手动回拨内部时间不可行，改为验证第二次 touch 覆盖
  wa.touch('p3');
  const second = wa.getLastActivity('p3');
  assert.ok(second >= first);
  assert.strictEqual(wa.getAgoSeconds('p3'), Math.floor((Date.now() - second) / 1000));
});

test('不同 profileId 各自独立记录', () => {
  wa.touch('a');
  assert.ok(wa.getLastActivity('a') !== null);
  assert.strictEqual(wa.getLastActivity('b'), null);
});

test('非法 profileId（null/undefined/空/非字符串）不记录', () => {
  wa.touch(null);
  wa.touch(undefined);
  wa.touch('');
  wa.touch(123);
  assert.strictEqual(wa.getLastActivity(null), null);
  assert.strictEqual(wa.getLastActivity(''), null);
  assert.strictEqual(wa.getLastActivity(123), null);
});

test('getAgoSeconds 反映经过时间（模拟旧时间戳）', () => {
  wa.touch('p4');
  // 通过 getLastActivity 拿到 ts，断言 ago 计算一致
  const ts = wa.getLastActivity('p4');
  assert.strictEqual(wa.getAgoSeconds('p4'), Math.floor((Date.now() - ts) / 1000));
});

test('_reset 清空所有记录', () => {
  wa.touch('x');
  assert.ok(wa.getLastActivity('x') !== null);
  wa._reset();
  assert.strictEqual(wa.getLastActivity('x'), null);
});
