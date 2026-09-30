'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// 单元测试：src/preload/dom/retry-engine.js
// 覆盖 readConfig（localStorage 依赖）、pickDelay（纯函数）、decideRetry（纯函数）。
// retry-engine 顶层会 require chat-input / overlay-ui，但这些在 Node 下可安全加载
// （require 本身不执行 DOM 逻辑），故无需额外 mock 模块依赖。

function freshEngine() {
  // 每次都重新 require 会受 require 缓存影响；这里直接拿模块对象，
  // 因为被测的 readConfig/pickDelay/decideRetry 都是无状态/纯函数。
  return require('../../src/preload/dom/retry-engine');
}

function withLocalStorage(store, fn) {
  const prev = global.localStorage;
  global.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  try {
    return fn();
  } finally {
    if (prev === undefined) delete global.localStorage;
    else global.localStorage = prev;
  }
}

test('readConfig：无 localStorage 时返回默认值', () => {
  const { readConfig, DEFAULT_PROMPT } = freshEngine();
  withLocalStorage({}, () => {
    const cfg = readConfig();
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.delayMin, 4000);
    assert.strictEqual(cfg.delayMax, 10000);
    assert.strictEqual(cfg.count, 10);
    assert.strictEqual(cfg.delay429, 60000);
    assert.strictEqual(cfg.count429, 20);
    assert.strictEqual(cfg.prompt, DEFAULT_PROMPT);
  });
});

test('readConfig：localStorage 有值时覆盖默认值', () => {
  const { readConfig } = freshEngine();
  withLocalStorage({
    'tokfree-retry-enabled': '0',
    'tokfree-retry-delay-min': '1000',
    'tokfree-retry-delay-max': '2000',
    'tokfree-retry-count': '3',
    'tokfree-retry-429-delay': '5000',
    'tokfree-retry-429-count': '4',
    'tokfree-retry-prompt': '自定义提示',
  }, () => {
    const cfg = readConfig();
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.delayMin, 1000);
    assert.strictEqual(cfg.delayMax, 2000);
    assert.strictEqual(cfg.count, 3);
    assert.strictEqual(cfg.delay429, 5000);
    assert.strictEqual(cfg.count429, 4);
    assert.strictEqual(cfg.prompt, '自定义提示');
  });
});

test('readConfig：非法值（NaN）回退默认', () => {
  const { readConfig } = freshEngine();
  withLocalStorage({
    'tokfree-retry-delay-min': 'abc',
    'tokfree-retry-count': 'xyz',
    'tokfree-retry-429-delay': '',
  }, () => {
    const cfg = readConfig();
    assert.strictEqual(cfg.delayMin, 4000);
    assert.strictEqual(cfg.count, 10);
    assert.strictEqual(cfg.delay429, 60000);
  });
});

test('readConfig：enabled 仅 "1" 为真，其余为假', () => {
  const { readConfig } = freshEngine();
  withLocalStorage({ 'tokfree-retry-enabled': 'yes' }, () => {
    assert.strictEqual(readConfig().enabled, false);
  });
  withLocalStorage({ 'tokfree-retry-enabled': '1' }, () => {
    assert.strictEqual(readConfig().enabled, true);
  });
});

test('pickDelay：min===max 返回该值', () => {
  const { pickDelay } = freshEngine();
  assert.strictEqual(pickDelay(5000, 5000), 5000);
});

test('pickDelay：max<min 时返回 min', () => {
  const { pickDelay } = freshEngine();
  assert.strictEqual(pickDelay(8000, 2000), 8000);
});

test('pickDelay：正常范围返回 [min,max) 内整数', () => {
  const { pickDelay } = freshEngine();
  for (let i = 0; i < 200; i++) {
    const d = pickDelay(1000, 2000);
    assert.ok(Number.isInteger(d), '应为整数: ' + d);
    assert.ok(d >= 1000 && d < 2000, '应在 [1000,2000) 内: ' + d);
  }
});

test('pickDelay：非法入参归零 / 收敛', () => {
  const { pickDelay } = freshEngine();
  assert.strictEqual(pickDelay(NaN, NaN), 0);
  assert.strictEqual(pickDelay(-5, -10), 0);
});

const baseCfg = { count: 3, count429: 2, delay429: 60000, delayMin: 4000, delayMax: 10000 };

test('decideRetry：普通错误未超限 → retry=true, kind=normal', () => {
  const { decideRetry } = freshEngine();
  const r = decideRetry({}, baseCfg, { normalCount: 0, count429: 0 });
  assert.strictEqual(r.retry, true);
  assert.strictEqual(r.kind, 'normal');
  assert.ok(r.delay >= baseCfg.delayMin && r.delay < baseCfg.delayMax);
});

test('decideRetry：普通已达上限 → retry=false', () => {
  const { decideRetry } = freshEngine();
  const r = decideRetry({}, baseCfg, { normalCount: 3, count429: 0 });
  assert.strictEqual(r.retry, false);
  assert.strictEqual(r.kind, 'normal');
});

test('decideRetry：普通上限为负（无限）→ 永远重试', () => {
  const { decideRetry } = freshEngine();
  const cfg = Object.assign({}, baseCfg, { count: -1 });
  const r = decideRetry({}, cfg, { normalCount: 9999, count429: 0 });
  assert.strictEqual(r.retry, true);
  assert.strictEqual(r.kind, 'normal');
});

test('decideRetry：429 未超限 → kind=429, delay=delay429', () => {
  const { decideRetry } = freshEngine();
  const r = decideRetry({ httpStatus: 429 }, baseCfg, { normalCount: 0, count429: 0 });
  assert.strictEqual(r.retry, true);
  assert.strictEqual(r.kind, '429');
  assert.strictEqual(r.delay, baseCfg.delay429);
});

test('decideRetry：429 超限 → retry=false', () => {
  const { decideRetry } = freshEngine();
  const r = decideRetry({ httpStatus: 429 }, baseCfg, { normalCount: 0, count429: 2 });
  assert.strictEqual(r.retry, false);
  assert.strictEqual(r.kind, '429');
});

test('decideRetry：会话不一致 → retry=false, reason 含"会话"', () => {
  const { decideRetry } = freshEngine();
  const r = decideRetry({ sessionId: 'old' }, baseCfg, { normalCount: 0, count429: 0 }, false);
  assert.strictEqual(r.retry, false);
  assert.strictEqual(r.kind, null);
  assert.ok(r.reason.indexOf('会话') !== -1, 'reason 应含会话: ' + r.reason);
});

test('decideRetry：会话一致 → 正常判定（不受 isSameSession=true 影响）', () => {
  const { decideRetry } = freshEngine();
  const r = decideRetry({ sessionId: 'same' }, baseCfg, { normalCount: 0, count429: 0 }, true);
  assert.strictEqual(r.retry, true);
  assert.strictEqual(r.kind, 'normal');
});

test('decideRetry：429 且 delay429 非有限值时回退 60000', () => {
  const { decideRetry } = freshEngine();
  const cfg = Object.assign({}, baseCfg, { delay429: NaN });
  const r = decideRetry({ httpStatus: 429 }, cfg, { normalCount: 0, count429: 0 });
  assert.strictEqual(r.delay, 60000);
});

test('decideRetry：state 缺省安全（视为 0）', () => {
  const { decideRetry } = freshEngine();
  const r = decideRetry({}, baseCfg, undefined);
  assert.strictEqual(r.retry, true);
  assert.strictEqual(r.kind, 'normal');
});

test('decideRetry：业务码 40029（数字）→ 走 429 限流退避', () => {
  const { decideRetry } = freshEngine();
  const r = decideRetry({ bizCode: 40029 }, baseCfg, { normalCount: 0, count429: 0 });
  assert.strictEqual(r.retry, true);
  assert.strictEqual(r.kind, '429');
  assert.strictEqual(r.delay, baseCfg.delay429);
});

test('decideRetry：业务码 "40029"（字符串）→ 走 429 限流退避', () => {
  const { decideRetry } = freshEngine();
  const r = decideRetry({ bizCode: '40029' }, baseCfg, { normalCount: 0, count429: 0 });
  assert.strictEqual(r.retry, true);
  assert.strictEqual(r.kind, '429');
});

test('decideRetry：业务码 40029 超限 → retry=false, kind=429', () => {
  const { decideRetry } = freshEngine();
  const r = decideRetry({ bizCode: 40029 }, baseCfg, { normalCount: 0, count429: 2 });
  assert.strictEqual(r.retry, false);
  assert.strictEqual(r.kind, '429');
});

test('decideRetry：其他业务码 → 走普通重试', () => {
  const { decideRetry } = freshEngine();
  const r = decideRetry({ bizCode: 50001 }, baseCfg, { normalCount: 0, count429: 0 });
  assert.strictEqual(r.kind, 'normal');
});
