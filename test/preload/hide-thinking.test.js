'use strict';

/**
 * hide-tool-turn 思考块检测单测（findThinkingContainers）
 * 用极简假 DOM 模拟 DeepSeek 消息结构：
 *   .ds-message
 *     ├─ <思考容器>（含「已深度思考（用时 X 秒）」标题）
 *     └─ .ds-markdown（最终答案，绝不可被隐藏）
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { findThinkingContainers } = require('../../src/preload/dom/hide-tool-turn');

/** 构造假 DOM 节点（实现检测逻辑用到的最小接口） */
function makeNode(cls, text, kids) {
  const node = {
    className: cls || '',
    classList: { contains: (c) => (cls || '').split(/\s+/).indexOf(c) !== -1 },
    textContent: text || '',
    children: kids || [],
    parentElement: null,
  };
  for (const k of node.children) k.parentElement = node;
  node.querySelectorAll = (sel) => {
    const all = [];
    const walk = (n) => { for (const c of n.children) { all.push(c); walk(c); } };
    walk(node);
    if (sel === '*') return all;
    // 支持 [class*="xxx"] 组合选择器（多段逗号分隔）
    const tokens = [];
    const re = /\[class\*="([^"]+)"\]/g;
    let m;
    while ((m = re.exec(sel))) tokens.push(m[1]);
    if (tokens.length === 0) return [];
    return all.filter((n) => tokens.some((tk) => (n.className || '').indexOf(tk) !== -1));
  };
  return node;
}

function deepseekMessage(withThinking) {
  const markdown = makeNode('ds-markdown', '最终答案文本', []);
  const kids = [];
  if (withThinking) {
    const header = makeNode('_ef1676d8', '已深度思考（用时 12 秒）', []);
    const body = makeNode('_aaa111', '第一步：分析……第二步：……', [header]);
    const thinkContainer = makeNode('_0f72b0b', '', [body]);
    kids.push(thinkContainer, markdown);
  } else {
    kids.push(markdown);
  }
  const msg = makeNode('ds-message', '', kids);
  return { msg, markdown, thinkContainer: withThinking ? kids[0] : null };
}

test('DeepSeek：思考容器被检出，最终答案 .ds-markdown 不受影响', () => {
  const { msg, thinkContainer } = deepseekMessage(true);
  const found = findThinkingContainers(msg);
  assert.equal(found.length, 1);
  assert.equal(found[0], thinkContainer);
  assert.ok(!found.some((c) => c.classList.contains('ds-markdown')));
});

test('DeepSeek：无思考块的消息不检出任何容器', () => {
  const { msg } = deepseekMessage(false);
  assert.deepEqual(findThinkingContainers(msg), []);
});

test('DeepSeek：多个嵌套标题节点收敛为同一个容器（去重）', () => {
  const innerHeader = makeNode('_h1', '已深度思考（用时 3 秒）', []);
  const innerHeader2 = makeNode('_h2', '深度思考（用时 3 秒）', []);
  const body = makeNode('_b', '', [innerHeader, innerHeader2]);
  const thinkContainer = makeNode('_0f72b0b', '', [body]);
  const msg = makeNode('ds-message', '', [thinkContainer, makeNode('ds-markdown', '答案', [])]);
  const found = findThinkingContainers(msg);
  assert.equal(found.length, 1);
  assert.equal(found[0], thinkContainer);
});

test('DeepSeek：超长文本节点不当作思考标题（>60 字符）', () => {
  const longText = '已深度思考' + '（用时很长）'.repeat(20);
  const header = makeNode('_h', longText, []);
  const container = makeNode('_c', '', [header]);
  const msg = makeNode('ds-message', '', [container, makeNode('ds-markdown', '答案', [])]);
  assert.deepEqual(findThinkingContainers(msg), []);
});

test('其他平台：class 含 thinking/reasoning 的节点被检出', () => {
  const thinkEl = makeNode('thinking-block', '...', []);
  const msg = makeNode('message-row', '', [thinkEl, makeNode('content', '答案', [])]);
  const found = findThinkingContainers(msg);
  assert.equal(found.length, 1);
  assert.equal(found[0], thinkEl);
});
