/**
 * DeepSeek 会话目录抓取模块（纯 preload 模块，CommonJS）
 *
 * 目标：从网页端 REST API 拉取【全量】对话列表，供 Agent 会话栏同步。
 *
 * 已知探测（来自 bundle 逆向）：
 *  - 接口：POST /api/v0/chat_session/fetch_page
 *  - 首屏 body: { count: 50 }
 *  - 翻页 body: { count: 50, lte_cursor: { pinned: <bool>, updated_at: <num> } }
 *  - 鉴权：localStorage['tokfree-ds-headers'] 中的 authorization 头
 *  - 响应统一格式 { code, msg, data }
 *  - 会话字段：{ id, title, updated_at, pinned }
 *
 * 依赖：hook 已把真实请求头缓存到 localStorage['tokfree-ds-headers']
 * 不依赖 DOM（仅 fetch + localStorage）。
 */

/** 日志前缀 */
function logStep(msg) {
  try { console.log('[TokFree SessionCatalog] ' + msg); } catch (_) {}
}

/** 从 localStorage 读取缓存的真实请求头 */
function getCachedHeaders() {
  try {
    const raw = localStorage.getItem('tokfree-ds-headers');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch (_) {
    return null;
  }
}

/** 单页请求：尝试多种调用形式，返回 { ok, json, form, httpStatus, raw } */
async function requestPage(form, headers) {
  const h = Object.assign({}, headers || {});
  if (!h['content-type']) h['content-type'] = 'application/json';

  // 尝试两种方法：先 POST（bundle 探测），再 GET
  const attempts = [];

  // POST 形式
  attempts.push(async () => {
    const resp = await fetch('/api/v0/chat_session/fetch_page', {
      method: 'POST',
      headers: h,
      body: JSON.stringify(form),
    });
    const txt = await resp.text();
    return { httpStatus: resp.status, raw: txt, method: 'POST' };
  });

  // 备用：GET（参数挂 querystring）
  attempts.push(async () => {
    const qs = new URLSearchParams();
    qs.set('count', String(form.count || 50));
    if (form.lte_cursor) {
      qs.set('lte_cursor', JSON.stringify(form.lte_cursor));
    }
    const resp = await fetch('/api/v0/chat_session/fetch_page?' + qs.toString(), {
      method: 'GET',
      headers: h,
    });
    const txt = await resp.text();
    return { httpStatus: resp.status, raw: txt, method: 'GET' };
  });

  let last = null;
  for (const run of attempts) {
    let r;
    try {
      r = await run();
    } catch (e) {
      last = { ok: false, error: 'fetch 异常: ' + (e && e.message), form };
      continue;
    }
    let json = null;
    try { json = JSON.parse(r.raw); } catch (_) {}
    if (json && typeof json === 'object' && json.code === 0) {
      return { ok: true, json, form, httpStatus: r.httpStatus, method: r.method };
    }
    last = {
      ok: false,
      error: 'code!==0 或无法解析',
      httpStatus: r.httpStatus,
      method: r.method,
      raw: String(r.raw).slice(0, 400),
      json,
      form,
    };
  }
  return last || { ok: false, error: '无可用请求形式', form };
}

/** 从响应中容错提取会话数组 */
function extractSessions(json) {
  if (!json || typeof json !== 'object') return null;
  const paths = [
    (j) => j.data && j.data.chat_sessions,
    (j) => j.data && j.data.biz_data && j.data.biz_data.chat_sessions,
    (j) => j.data && j.data.list,
    (j) => j.data && j.data.biz_data && j.data.biz_data.list,
    (j) => j.data && j.data.sessions,
    (j) => j.chat_sessions,
  ];
  for (const p of paths) {
    let v;
    try { v = p(json); } catch (_) { v = null; }
    if (Array.isArray(v)) return v;
  }
  return null;
}

/** 规范化单条会话 → { id, title, updatedAt, pinned } */
function normalizeSession(s) {
  if (!s || typeof s !== 'object') return null;
  const id = s.id || s.chat_session_id || s.session_id;
  if (!id) return null;
  const rawUpdated = (typeof s.updated_at === 'number') ? s.updated_at : Number(s.updated_at) || 0;
  return {
    id: String(id),
    title: s.title || s.name || '',
    updatedAt: rawUpdated * 1000,
    pinned: !!s.pinned,
  };
}

/** 从单条原始会话生成翻页 cursor */
function buildCursor(lastRaw) {
  if (!lastRaw || typeof lastRaw !== 'object') return null;
  const rawUpdated = (typeof lastRaw.updated_at === 'number') ? lastRaw.updated_at : Number(lastRaw.updated_at);
  if (!rawUpdated || Number.isNaN(rawUpdated)) return null;
  return { pinned: !!lastRaw.pinned, updated_at: rawUpdated };
}

/**
 * 拉取全量对话列表。
 * @param {Object} [opts]
 * @param {number} [opts.count=50] 每页数量
 * @param {number} [opts.maxPages=20] 最大页数（防死循环）
 * @returns {Promise<{ok:boolean, conversations?:Array, pages?:number, error?:string}>}
 */
async function fetchAllConversations(opts) {
  opts = opts || {};
  const count = typeof opts.count === 'number' && opts.count > 0 ? opts.count : 50;
  const maxPages = typeof opts.maxPages === 'number' && opts.maxPages > 0 ? opts.maxPages : 20;

  try {
    const headers = getCachedHeaders();
    if (!headers) {
      return { ok: false, error: '未找到 localStorage[tokfree-ds-headers]，无法鉴权' };
    }

    const all = [];
    const seen = Object.create(null);
    let pages = 0;
    let cursor = null;
    let lastFail = null;

    for (let i = 0; i < maxPages; i++) {
      const form = { count: count };
      if (cursor) form.lte_cursor = cursor;

      const res = await requestPage(form, headers);
      pages++;

      if (!res.ok) {
        lastFail = res;
        logStep('第 ' + pages + ' 页请求失败: ' + (res.error || '') +
          (res.httpStatus ? ' HTTP ' + res.httpStatus : ''));
        break;
      }

      const arr = extractSessions(res.json);
      if (!Array.isArray(arr)) {
        logStep('第 ' + pages + ' 页响应无 chat_sessions 字段');
        break;
      }
      if (arr.length === 0) break;

      for (const raw of arr) {
        const n = normalizeSession(raw);
        if (n && !seen[n.id]) {
          seen[n.id] = true;
          all.push({ ...n, _raw: raw });
        }
      }

      // 停止条件：少于一页数量（没有更多）
      if (arr.length < count) break;

      const nextCursor = buildCursor(arr[arr.length - 1]);
      if (!nextCursor) break;
      cursor = nextCursor;
    }

    if (all.length === 0 && lastFail) {
      return {
        ok: false,
        error: '请求失败: ' + (lastFail.error || '未知') +
          (lastFail.raw ? ' | 响应: ' + lastFail.raw : ''),
      };
    }

    // 去内部字段 + 按 updatedAt 倒序
    const conversations = all
      .map((x) => ({ id: x.id, title: x.title, updatedAt: x.updatedAt, pinned: x.pinned }))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    return { ok: true, conversations, pages };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}

module.exports = { getCachedHeaders, fetchAllConversations };
