'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// 回归测试：isGenerating() 多策略容错。
// 背景：5 个 provider 原先都只依赖单一易变选择器，站点改版会静默失效
// （isGenerating 恒 false → 看门狗心跳不刷 → 误催）。
// 修复后每个 isGenerating 内建 selectors 数组，命中【可见】元素即返回 true。

const providers = [
  { name: 'deepseek', path: '../../src/providers/deepseek', semantic: '[aria-label*="停止"]', fallback: '[class*="stop-button"]' },
  { name: 'claude', path: '../../src/providers/claude', semantic: 'button[aria-label="Stop response"]', fallback: 'button[class*="stop"]' },
  { name: 'chatgpt', path: '../../src/providers/chatgpt', semantic: 'button[data-testid="stop-button"]', fallback: 'button[class*="stop"]' },
  { name: 'qwen', path: '../../src/providers/qwen', semantic: 'button.stop-button', fallback: 'button[class*="stop"]' },
];

// 构造一个 mock document：仅在 matchSelector 精确匹配时返回元素数组，其余返回 []
function makeDoc(matchSelector, el) {
  return {
    querySelectorAll(sel) {
      return sel === matchSelector ? [el] : [];
    },
  };
}

for (const p of providers) {
  test(p.name + '.isGenerating 命中语义选择器返回 true', () => {
    const provider = require(p.path);
    global.document = makeDoc(p.semantic, { offsetWidth: 10 });
    try {
      assert.strictEqual(provider.isGenerating(), true);
    } finally {
      delete global.document;
    }
  });

  test(p.name + '.isGenerating 仅命中 class 兜底也返回 true', () => {
    const provider = require(p.path);
    global.document = makeDoc(p.fallback, { offsetWidth: 10 });
    try {
      assert.strictEqual(provider.isGenerating(), true);
    } finally {
      delete global.document;
    }
  });

  test(p.name + '.isGenerating 都不命中返回 false', () => {
    const provider = require(p.path);
    global.document = { querySelectorAll() { return []; } };
    try {
      assert.strictEqual(provider.isGenerating(), false);
    } finally {
      delete global.document;
    }
  });

  test(p.name + '.isGenerating 元素隐藏（offsetWidth=0）返回 false', () => {
    const provider = require(p.path);
    global.document = makeDoc(p.semantic, { offsetWidth: 0 });
    try {
      assert.strictEqual(provider.isGenerating(), false);
    } finally {
      delete global.document;
    }
  });
}

