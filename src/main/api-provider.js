/**
 * API 型 Provider 主进程传输层（additive，不影响现有逻辑）
 * 职责：代表渲染进程向 OpenAI 兼容后端发起 HTTP 请求，规避 CORS。
 * 安全：仅允许 http(s)；不持久化任何密钥（密钥由调用方在请求里传入）。
 */
const { logger } = (() => { try { return require('../../utils/log'); } catch (_) { return { logger: console }; } })();

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** 校验目标 URL 合法性（仅 http/https） */
function assertSafeUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch (_) { throw new Error('无效的 URL'); }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) throw new Error('仅支持 http/https');
  return u;
}

/** 归一化 baseUrl：去掉末尾斜杠 */
function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

/**
 * 发起一次 API 请求（非流式或流式）。
 * @param {object} opts
 * @param {string} opts.baseUrl  形如 http://localhost:3000/v1
 * @param {string} opts.path     形如 /chat/completions
 * @param {string} [opts.authKey] Bearer 令牌
 * @param {string} [opts.method] 默认 POST
 * @param {object} [opts.body]   JSON 请求体
 * @param {boolean} [opts.stream] 是否流式（返回 { stream:true, ... } 由调用方处理）
 * @returns {Promise<object>} { ok, status, data } 或 { ok:true, stream:true, events }
 */
async function apiRequest(opts) {
  const baseUrl = normalizeBaseUrl(opts && opts.baseUrl);
  const path = (opts && opts.path) || '/chat/completions';
  const method = (opts && opts.method) || 'POST';
  if (!baseUrl) throw new Error('缺少 baseUrl');
  const url = assertSafeUrl(baseUrl + path);

  const headers = { 'Content-Type': 'application/json' };
  if (opts && opts.authKey) headers['Authorization'] = 'Bearer ' + opts.authKey;

  const init = { method, headers };
  if (opts && opts.body != null) init.body = JSON.stringify(opts.body);

  const res = await fetch(url.toString(), init);
  const ok = res.ok;
  const status = res.status;

  // 非流式：直接读 JSON 文本
  if (!opts || !opts.stream) {
    let data;
    const text = await res.text();
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    let error = '';
    if (!ok) {
      error = (data && data.error && (data.error.message || data.error))
        || (data && data.raw)
        || ('HTTP ' + status);
      if (typeof error !== 'string') error = JSON.stringify(error);
    }
    return { ok, status, data, error };
  }

  // 流式：收集 SSE 文本（简单聚合，避免主进程长连接管理复杂度）
  let streamText = '';
  try {
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (reader) {
      const decoder = new TextDecoder();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        streamText += decoder.decode(value, { stream: true });
      }
    } else {
      streamText = await res.text();
    }
  } catch (err) {
    return { ok: false, status, error: (err && err.message) || String(err) };
  }
  const error = ok ? '' : (streamText || ('HTTP ' + status));
  return { ok, status, streamText, error };
}

module.exports = { apiRequest, assertSafeUrl, normalizeBaseUrl };
