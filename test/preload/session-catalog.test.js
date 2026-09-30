'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { getCachedHeaders, fetchAllConversations } = require('../../src/preload/dom/session-catalog');

// ============ 测试辅助 ============

/** 设置 localStorage（mock）——传入对象则序列化，null 则无值，字符串则原样 */
function setLocalStorage(value) {
  global.localStorage = {
    getItem: (k) => {
      if (k !== 'tokfree-ds-headers') return null;
      if (value === null) return null;
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
  };
}

/** 设置 fetch mock：按调用序号返回预设 payload 列表；payload 为 Error 则 reject */
function setFetch(pages) {
  let call = 0;
  global.fetch = async () => {
    const payload = pages[call] !== undefined ? pages[call] : (pages[pages.length - 1] || []);
    call++;
    if (payload instanceof Error) throw payload;
    return {
      status: 200,
      text: async () => JSON.stringify(payload),
    };
  };
}

beforeEach(() => {
  setLocalStorage({ authorization: 'Bearer x' });
});

// ============ getCachedHeaders ============

test('getCachedHeaders: 无值返回 null', () => {
  setLocalStorage(null);
  assert.strictEqual(getCachedHeaders(), null);
});

test('getCachedHeaders: 有效 JSON 对象返回该对象', () => {
  setLocalStorage({ authorization: 'Bearer abc', cookie: 'x=1' });
  const h = getCachedHeaders();
  assert.deepStrictEqual(h, { authorization: 'Bearer abc', cookie: 'x=1' });
});

test('getCachedHeaders: 损坏 JSON 返回 null', () => {
  setLocalStorage('{{{bad json');
  assert.strictEqual(getCachedHeaders(), null);
});

test('getCachedHeaders: 非对象（字符串字面量）返回 null', () => {
  setLocalStorage('"just a string"');
  assert.strictEqual(getCachedHeaders(), null);
});

// ============ fetchAllConversations ============

test('fetchAllConversations: 分页聚合 + 字段映射 + 去重 + 倒序', async () => {
  setFetch([
    { code: 0, data: { chat_sessions: [
      { id: 'a', title: 'A', updated_at: 100, pinned: false },
      { id: 'b', title: 'B', updated_at: 200, pinned: true },
    ] } },
    { code: 0, data: { chat_sessions: [
      { id: 'b', title: 'B(dup)', updated_at: 200, pinned: true },
      { id: 'c', title: 'C', updated_at: 300, pinned: false },
    ] } },
    { code: 0, data: { chat_sessions: [] } },
  ]);
  const r = await fetchAllConversations({ count: 2 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.conversations.length, 3, '去重后应 3 条');
  assert.deepStrictEqual(r.conversations.map((x) => x.id), ['c', 'b', 'a'], 'updatedAt 倒序');
  assert.strictEqual(r.conversations[0].updatedAt, 300 * 1000, 'updated_at*1000');
  assert.strictEqual(r.conversations[0].pinned, false);
  assert.strictEqual(r.conversations[1].pinned, true);
  assert.strictEqual(r.pages, 3);
});

test('fetchAllConversations: 多路径容错 data.biz_data.chat_sessions', async () => {
  setFetch([
    { code: 0, data: { biz_data: { chat_sessions: [
      { id: 'x', name: 'X 名', updated_at: 5 },
    ] } } },
  ]);
  const r = await fetchAllConversations({});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.conversations.length, 1);
  assert.strictEqual(r.conversations[0].id, 'x');
  assert.strictEqual(r.conversations[0].title, 'X 名', 'name 兜底为 title');
  assert.strictEqual(r.conversations[0].updatedAt, 5000);
});

test('fetchAllConversations: 缺少鉴权头返回 ok:false 不抛', async () => {
  setLocalStorage(null);
  const r = await fetchAllConversations({});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /tokfree-ds-headers/);
});

test('fetchAllConversations: fetch reject 返回 ok:false 不抛', async () => {
  setFetch([new Error('network down')]);
  const r = await fetchAllConversations({});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /请求失败|fetch 异常/);
});

test('fetchAllConversations: code!==0 返回 ok:false 不抛', async () => {
  setFetch([{ code: 1, msg: 'no auth', data: null }]);
  const r = await fetchAllConversations({});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /请求失败/);
});
