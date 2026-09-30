'use strict';
/**
 * Qwen 拦截器功能测试
 * 在 Node 环境里模拟 window / fetch / SSE 响应，验证主世界注入脚本能：
 *   1. 只拦截 POST /api/chat/completions（含 /api/v2 前缀）
 *   2. 正确拼接 choices[0].delta.content
 *   3. 过滤 think / tool 等非正文 phase
 *   4. 在 [DONE] 或 response.stopped 后派发 finished 事件
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { qwenHookSource } = require('../../src/interceptor/qwen-hook');

/** 构造一个可被 getReader() 消费的伪响应流 */
function makeBody(chunks) {
  let i = 0;
  return {
    getReader() {
      return {
        read() {
          if (i < chunks.length) {
            return Promise.resolve({ value: new TextEncoder().encode(chunks[i++]), done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

/**
 * 搭建伪浏览器环境（window / document / XMLHttpRequest / CustomEvent），
 * 并让 window.fetch 返回给定响应体。
 */
function setup(withBody) {
  const events = [];
  const fakeWindow = {
    dispatchEvent(ev) { events.push(ev); return true; },
    fetch() {
      return Promise.resolve({
        body: withBody,
        clone() { return { body: withBody }; },
      });
    },
  };
  class FakeXHR { open() {} send() {} addEventListener() {} }

  const saved = {
    window: global.window,
    document: global.document,
    XMLHttpRequest: global.XMLHttpRequest,
    CustomEvent: global.CustomEvent,
  };
  global.window = fakeWindow;
  global.document = { baseURI: 'https://chat.qwen.ai/' };
  global.XMLHttpRequest = FakeXHR;
  global.CustomEvent = class CustomEvent {
    constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; }
  };

  return {
    events,
    restore() {
      global.window = saved.window;
      global.document = saved.document;
      global.XMLHttpRequest = saved.XMLHttpRequest;
      global.CustomEvent = saved.CustomEvent;
    },
  };
}

/** 执行注入脚本并发起一次请求，返回收集到的事件 */
async function run(frames, url, method) {
  const env = setup(makeBody(frames));
  try {
    eval(qwenHookSource()); // eslint-disable-line no-eval
    await global.window.fetch(url || 'https://chat.qwen.ai/api/chat/completions', { method: method || 'POST' });
    await new Promise(resolve => setTimeout(resolve, 50));
  } finally {
    env.restore();
  }
  return env.events;
}

function frame(obj) {
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}

function delta(content, phase) {
  const d = { content };
  if (phase) d.phase = phase;
  return { choices: [{ delta: d }] };
}

test('qwen 拦截器：拼接正文并在 [DONE] 后派发 finished', async () => {
  const events = await run([
    frame(delta('```tokfree\n')),
    frame(delta('await read("a.js");\n')),
    frame(delta('```')),
    'data: [DONE]\n\n',
  ]);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, 'tokfree-ai-response');
  assert.strictEqual(events[0].detail.finished, true);
  assert.strictEqual(events[0].detail.text, '```tokfree\nawait read("a.js");\n```');
});

test('qwen 拦截器：过滤 think / tool 等非正文 phase', async () => {
  const events = await run([
    frame(delta('让我想想', 'think')),
    frame(delta('正文内容', 'answer')),
    frame(delta('工具调用', 'tool')),
    'data: [DONE]\n\n',
  ]);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].detail.text, '正文内容');
});

test('qwen 拦截器：正文为空时用其他 phase 兜底', async () => {
  const events = await run([
    frame(delta('仅有的内容', 'DeepThinking')),
    'data: [DONE]\n\n',
  ]);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].detail.text, '仅有的内容');
});

test('qwen 拦截器：携带 usage 帧时带出 tokenUsage', async () => {
  const events = await run([
    frame(Object.assign(delta('回答正文'), {
      usage: { input_tokens: 1111, output_tokens: 42, total_tokens: 1153 },
    })),
    'data: [DONE]\n\n',
  ]);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].detail.text, '回答正文');
  assert.ok(events[0].detail.tokenUsage, '应带出 tokenUsage');
  assert.strictEqual(events[0].detail.tokenUsage.accumulatedTokens, 1153);
  assert.strictEqual(events[0].detail.tokenUsage.inputTokens, 1111);
  assert.strictEqual(events[0].detail.tokenUsage.outputTokens, 42);
});

test('qwen 拦截器：无 usage 帧时 tokenUsage 为 null', async () => {
  const events = await run([
    frame(delta('无用量正文')),
    'data: [DONE]\n\n',
  ]);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].detail.tokenUsage, null);
});

test('qwen 拦截器：多帧 usage 取最新值', async () => {
  const events = await run([
    frame(Object.assign(delta('第一段'), {
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    })),
    frame(Object.assign(delta('第二段'), {
      usage: { input_tokens: 100, output_tokens: 25, total_tokens: 125 },
    })),
    'data: [DONE]\n\n',
  ]);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].detail.tokenUsage.accumulatedTokens, 125);
});

test('qwen 拦截器：response.stopped 视为结束', async () => {
  const events = await run([
    frame(delta('hello')),
    frame({ 'response.stopped': { response_id: 'r1' } }),
  ]);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].detail.text, 'hello');
});

test('qwen 拦截器：忽略非 completions 请求', async () => {
  const events = await run([frame(delta('不该被抓到'))], 'https://chat.qwen.ai/api/v1/chats');
  assert.strictEqual(events.length, 0);
});

test('qwen 拦截器：忽略 GET 请求', async () => {
  const events = await run([frame(delta('不该被抓到'))], 'https://chat.qwen.ai/api/chat/completions', 'GET');
  assert.strictEqual(events.length, 0);
});

test('qwen 拦截器：兼容 /api/v2/chat/completions', async () => {
  const events = await run(
    [frame(delta('v2 正文')), 'data: [DONE]\n\n'],
    'https://chat.qwen.ai/api/v2/chat/completions'
  );
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].detail.text, 'v2 正文');
});

// ============ 回归测试：thinking phase 误判（防复发） ============
// 背景：Qwen 新版 SSE 中，thinking_summary 阶段结束会发 delta.status=finished，
// 若被无条件当作整条回复结束，会提前派发空片段，导致后续 answer 正文（含 tokfree 代码块）
// 读不到。修复后 finished 仅在正文阶段（answer/deepthinking/缺省）才算整体结束。
// 以下用例使用真机抓包得到的真实帧结构。

/** 构造带 status / phase 的完整 SSE 帧（真实结构） */
function statusFrame(deltaObj) {
  return frame({ choices: [{ delta: deltaObj }] });
}

test('qwen 拦截器[回归]：thinking_summary 的 finished 不提前结束，正文代码块完整', async () => {
  const events = await run([
    // thinking_summary typing
    statusFrame({ role: 'assistant', content: '', phase: 'thinking_summary', status: 'typing' }),
    // thinking_summary finished —— 旧 bug 会在这一帧误判整体结束并派发空内容
    statusFrame({ role: 'assistant', content: '', phase: 'thinking_summary', status: 'finished' }),
    // answer typing（含代码块正文）
    statusFrame({ role: 'assistant', content: '\u0060\u0060\u0060tokfree\nawait read("a.js");\n\u0060\u0060\u0060', phase: 'answer', status: 'typing' }),
    // answer finished —— 这才是整条回复真正结束
    statusFrame({ content: '', role: 'assistant', status: 'finished', phase: 'answer' }),
    'data: [DONE]\n\n',
  ]);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].detail.finished, true);
  assert.ok(
    events[0].detail.text.includes('tokfree'),
    'thinking 阶段结束后不应提前派发空内容，正文应完整包含代码块；实际收到: ' + JSON.stringify(events[0].detail.text)
  );
  assert.ok(events[0].detail.text.includes('await read("a.js");'));
});

test('qwen 拦截器[回归]：仅 answer 阶段 finished 才结束（thinking 阶段不触发派发）', async () => {
  const events = await run([
    statusFrame({ role: 'assistant', content: '思考中', phase: 'thinking_summary', status: 'typing' }),
    statusFrame({ role: 'assistant', content: '', phase: 'thinking_summary', status: 'finished' }),
    statusFrame({ role: 'assistant', content: '你好', phase: 'answer', status: 'typing' }),
    statusFrame({ role: 'assistant', content: '', phase: 'answer', status: 'finished' }),
    'data: [DONE]\n\n',
  ]);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].detail.finished, true);
  // thinking_summary 是噪声 phase，不应混入正文；正文只应是 answer 阶段的内容
  assert.strictEqual(events[0].detail.text, '你好');
});

test('qwen 拦截器[回归]：status=error 无条件结束（任何 phase）', async () => {
  const events = await run([
    statusFrame({ role: 'assistant', content: '部分正文', phase: 'answer', status: 'typing' }),
    // error 出现在 thinking_summary 阶段也应结束（与 finished 的 phase 判定不同）
    statusFrame({ role: 'assistant', content: '', phase: 'thinking_summary', status: 'error' }),
  ]);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].detail.finished, true);
  assert.strictEqual(events[0].detail.text, '部分正文');
});
