'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  OpenShardXBrowserTool,
  ReadShardXPageTool,
  CloseShardXBrowserTool,
  __setMcpClient
} = require('../../tools/ShardXBrowserTool');

/** 构造一个记录调用的 mock mcp-client。 */
function makeMock(responses) {
  const calls = [];
  return {
    calls,
    async callMcpTool(server, tool, args) {
      calls.push({ server, tool, args });
      const resp = responses[tool];
      if (typeof resp === 'function') return resp(args);
      if (resp) return resp;
      return { content: [{ type: 'text', text: '{}' }] };
    }
  };
}

/** 简单的 text 内容封装。 */
function textResult(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text }] };
}

test('open_shardx_browser 创建 profile 并导航，返回 profile_id', async () => {
  const mock = makeMock({
    list_profiles: () => textResult({ profiles: [] }),
    create_temporary_profile: () => textResult({ id: 'prof-123' }),
    browser_navigate: () => textResult({ ok: true })
  });
  __setMcpClient(mock);
  try {
    const t = new OpenShardXBrowserTool();
    const r = await t.execute({ url: 'https://example.com' });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.data.profile_id, 'prof-123');
    assert.strictEqual(r.data.url, 'https://example.com');

    const tools = mock.calls.map(c => c.tool);
    assert.ok(tools.includes('create_temporary_profile'), '应创建 profile');
    assert.ok(tools.includes('browser_navigate'), '应导航');

    const nav = mock.calls.find(c => c.tool === 'browser_navigate');
    assert.strictEqual(nav.server, 'shardx');
    assert.strictEqual(nav.args.profile_id, 'prof-123');
    assert.strictEqual(nav.args.url, 'https://example.com');
  } finally {
    __setMcpClient(null);
  }
});

test('open_shardx_browser 提供 id 时复用已有 profile', async () => {
  const mock = makeMock({
    list_profiles: () => textResult({ profiles: [{ id: 'existing-1', name: 'mySite' }] }),
    browser_navigate: () => textResult({ ok: true })
  });
  __setMcpClient(mock);
  try {
    const t = new OpenShardXBrowserTool();
    const r = await t.execute({ url: 'https://a.com', id: 'mySite' });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.data.profile_id, 'existing-1');
    const tools = mock.calls.map(c => c.tool);
    assert.ok(!tools.includes('create_temporary_profile'), '复用时不应新建 profile');
  } finally {
    __setMcpClient(null);
  }
});

test('read_shardx_page mode 分支正确', async () => {
  const mock = makeMock({
    browser_current_url: () => textResult('https://page.com | Title'),
    browser_content: () => textResult('<html>full</html>'),
    browser_get_text: (args) => textResult('text of ' + (args.selector || 'body'))
  });
  __setMcpClient(mock);
  try {
    const t = new ReadShardXPageTool();

    const rUrl = await t.execute({ profile_id: 'p1', mode: 'url' });
    assert.strictEqual(rUrl.success, true);
    assert.match(rUrl.data, /page\.com/);

    const rHtml = await t.execute({ profile_id: 'p1', mode: 'html' });
    assert.strictEqual(rHtml.success, true);
    assert.match(rHtml.data, /<html>/);

    const rText = await t.execute({ profile_id: 'p1' });
    assert.strictEqual(rText.success, true);
    assert.strictEqual(rText.data, 'text of body');

    const rSel = await t.execute({ profile_id: 'p1', selector: '#main' });
    assert.strictEqual(rSel.data, 'text of #main');

    const tools = mock.calls.map(c => c.tool);
    assert.ok(tools.includes('browser_current_url'));
    assert.ok(tools.includes('browser_content'));
    assert.ok(tools.includes('browser_get_text'));
  } finally {
    __setMcpClient(null);
  }
});

test('close_shardx_browser 调 stop_profile 且参数为 id', async () => {
  const mock = makeMock({ stop_profile: () => textResult('stopped') });
  __setMcpClient(mock);
  try {
    const t = new CloseShardXBrowserTool();
    const r = await t.execute({ profile_id: 'p9' });
    assert.strictEqual(r.success, true);
    assert.strictEqual(mock.calls.length, 1);
    assert.strictEqual(mock.calls[0].tool, 'stop_profile');
    assert.strictEqual(mock.calls[0].args.id, 'p9');
  } finally {
    __setMcpClient(null);
  }
});

test('异常时返回 ToolResult.error', async () => {
  const mock = {
    async callMcpTool() {
      throw new Error('ECONNREFUSED connect failed');
    }
  };
  __setMcpClient(mock);
  try {
    const open = new OpenShardXBrowserTool();
    const r1 = await open.execute({ url: 'https://x.com' });
    assert.strictEqual(r1.success, false);
    assert.match(r1.error, /ShardX/);

    const read = new ReadShardXPageTool();
    const r2 = await read.execute({ profile_id: 'p1' });
    assert.strictEqual(r2.success, false);

    const close = new CloseShardXBrowserTool();
    const r3 = await close.execute({ profile_id: 'p1' });
    assert.strictEqual(r3.success, false);
  } finally {
    __setMcpClient(null);
  }
});

test('参数缺失时返回错误', async () => {
  const mock = makeMock({});
  __setMcpClient(mock);
  try {
    const open = new OpenShardXBrowserTool();
    const r1 = await open.execute({});
    assert.strictEqual(r1.success, false);

    const read = new ReadShardXPageTool();
    const r2 = await read.execute({});
    assert.strictEqual(r2.success, false);

    const close = new CloseShardXBrowserTool();
    const r3 = await close.execute({});
    assert.strictEqual(r3.success, false);

    assert.strictEqual(mock.calls.length, 0, '参数校验失败不应调用 MCP');
  } finally {
    __setMcpClient(null);
  }
});
