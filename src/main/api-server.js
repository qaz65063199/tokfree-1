/**
 * 本地 OpenAI 兼容 API 服务（MVP）
 * 把每个标签窗口的网页版 AI 暴露成本地 HTTP 接口：
 *   GET  /v1/models            -> 列出所有打开窗口（作为"模型"）
 *   POST /v1/chat/completions  -> 转发给指定窗口的网页 AI，等待回复后返回 OpenAI 格式 JSON
 *
 * 设计要点：
 * - 仅用 Node 内置 http（不引入 express）。
 * - 默认 enabled=false（不自动起服务，避免端口占用/安全隐患）。
 * - 请求-回复通过 requestId 关联：主进程向窗口发 'api-prompt'，preload 回传 'api-response'，
 *   这里用 waiting Map 挂起 Promise，resolveWait() 由 ipc 处理器调用。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const windowState = require('./window');
const profileManager = require('./profile-manager');

let server = null;          // http.Server
let config = null;          // 当前生效配置
const waiting = new Map();  // requestId -> { resolve, reject, timer }

const DEFAULT_CONFIG = { enabled: false, port: 8788, host: '127.0.0.1', timeoutMs: 120000 };

function getConfigFile() {
  return path.join(app.getPath('userData'), 'api-server.json');
}

/** 读取配置（容错：文件缺失/损坏返回默认） */
function readConfig() {
  try {
    const f = getConfigFile();
    if (fs.existsSync(f)) {
      const obj = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (obj && typeof obj === 'object') {
        const merged = Object.assign({}, DEFAULT_CONFIG, obj);
        if (!isFinite(merged.port) || merged.port <= 0) merged.port = DEFAULT_CONFIG.port;
        if (!merged.host) merged.host = DEFAULT_CONFIG.host;
        if (!isFinite(merged.timeoutMs) || merged.timeoutMs <= 0) merged.timeoutMs = DEFAULT_CONFIG.timeoutMs;
        return merged;
      }
    }
  } catch (e) {
    console.error('[ApiServer] 读取配置失败:', e && e.message);
  }
  return Object.assign({}, DEFAULT_CONFIG);
}

/** 写入配置 */
function writeConfig(patch) {
  const next = Object.assign({}, readConfig(), patch || {});
  try {
    fs.writeFileSync(getConfigFile(), JSON.stringify(next, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[ApiServer] 写入配置失败:', e && e.message);
    return false;
  }
}

// ================= 响应工具 =================

function sendJson(res, status, obj) {
  try {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  } catch (e) {
    try { res.end(); } catch (_) {}
  }
}

/** 写一条 SSE data 行（OpenAI 流式格式：data: <json>\n\n） */
function sendSse(res, obj) {
  try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (_) {}
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) { // 5MB 上限
        reject(new Error('请求体过大'));
        try { req.destroy(); } catch (_) {}
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ================= 业务逻辑 =================

/** 生成友好别名：平台-窗口名（保留中英文数字连字符，其余转 -，去重后返回） */
function slugName(name) {
  return String(name || "").trim()
    .replace(/[^0-9A-Za-z\u4e00-\u9fa5_-]/g, "-")  // 非法字符转 -
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
}

/** 计算窗口的友好别名：<平台>-<窗口名>（窗口名空则用平台名，平台空则 unknown） */
function aliasOf(ctx) {
  if (!ctx) return "";
  const providerId = ctx.providerId || "unknown";
  let name = "";
  try {
    const p = profileManager.getProfileById(ctx.profileId);
    if (p && p.name) name = p.name;
  } catch (_) {}
  if (name) return slugName(providerId + "-" + name) || slugName(providerId) || "unknown";
  return slugName(providerId) || "unknown";
}

/** 列出所有打开窗口作为"模型" */
function handleModels(res) {
  let contexts = [];
  try { contexts = windowState.getAllContexts() || []; } catch (_) { contexts = []; }
  const data = [];
  const used = new Set();
  for (const ctx of contexts) {
    if (!ctx || !ctx.profileId) continue;
    let name = ctx.profileId;
    try {
      const p = profileManager.getProfileById(ctx.profileId);
      if (p && p.name) name = p.name;
    } catch (_) {}
    // 友好别名：平台-窗口名，重复时追加 -2/-3...
    let alias;
    try { alias = aliasOf(ctx); } catch (_) { alias = ''; }
    if (!alias) alias = 'unknown';
    const base = alias;
    let n = 2;
    while (used.has(alias)) { alias = base + '-' + n; n++; }
    used.add(alias);
    data.push({
      id: alias,
      object: 'model',
      owned_by: ctx.providerId || 'unknown',
      name: name,
      profile_id: ctx.profileId,
    });
  }
  sendJson(res, 200, { object: 'list', data: data });
}

/** 解析目标窗口：model 可为 profileId、providerId 或 "provider:xxx" */
function resolveContext(model) {
  if (!model || typeof model !== 'string') return null;
  let id = model;
  if (id.indexOf('provider:') === 0) id = id.slice('provider:'.length);
  // 1) 直接按 profileId 匹配
  let ctx = null;
  try { ctx = windowState.getWindowByProfileId(model); } catch (_) {}
  if (ctx) return ctx;
  if (id !== model) {
    try { ctx = windowState.getWindowByProfileId(id); } catch (_) {}
    if (ctx) return ctx;
  }
  // 2) 按友好别名匹配（平台-窗口名，含去重后缀）
  let contexts = [];
  try { contexts = windowState.getAllContexts() || []; } catch (_) { contexts = []; }
  {
    const used = new Set();
    for (const c of contexts) {
      if (!c || !c.profileId) continue;
      let alias;
      try { alias = aliasOf(c); } catch (_) { alias = ''; }
      if (!alias) alias = 'unknown';
      const base = alias;
      let n = 2;
      while (used.has(alias)) { alias = base + '-' + n; n++; }
      used.add(alias);
      if (model === alias || id === alias) return c;
    }
  }
  // 3) 按 providerId 取第一个匹配窗口
  return contexts.find((c) => c && (c.providerId === model || c.providerId === id)) || null;
}

/** 把 OpenAI messages 拼成一段文本（system 放最前） */
function buildPrompt(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const parts = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role || 'user';
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.map((c) => {
        if (c && typeof c === 'object') return c.text || '';
        return c == null ? '' : String(c);
      }).join('');
    }
    if (content == null) content = '';
    parts.push(role + ': ' + content);
  }
  return parts.join('\n\n');
}

/** 生成 OpenAI 格式的 completion 响应 */
function buildCompletion(requestId, model, text) {
  return {
    id: 'chatcmpl-' + requestId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** 向窗口发消息并等待回复（Promise） */
function sendAndWait(ctx, requestId, prompt) {
  return new Promise((resolve, reject) => {
    const timeoutMs = (config && config.timeoutMs) || DEFAULT_CONFIG.timeoutMs;
    const timer = setTimeout(() => {
      waiting.delete(requestId);
      reject(new Error('等待网页 AI 回复超时(' + timeoutMs + 'ms)'));
    }, timeoutMs);
    waiting.set(requestId, { resolve, reject, timer });
    try {
      if (!ctx.win || !ctx.win.webContents || ctx.win.webContents.isDestroyed()) {
        clearTimeout(timer);
        waiting.delete(requestId);
        reject(new Error('目标窗口不可用'));
        return;
      }
      ctx.win.webContents.send('api-prompt', { requestId: requestId, message: prompt });
    } catch (err) {
      clearTimeout(timer);
      waiting.delete(requestId);
      reject(err);
    }
  });
}

/** 处理 /v1/chat/completions */
async function handleChat(req, res) {
  let parsed;
  try {
    const body = await readBody(req);
    parsed = JSON.parse(body || '{}');
  } catch (e) {
    return sendJson(res, 400, { error: { message: '请求体 JSON 解析失败: ' + (e && e.message), type: 'invalid_request_error' } });
  }
  const model = parsed.model || '';
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const ctx = resolveContext(model);
  if (!ctx) {
    return sendJson(res, 404, { error: { message: '未找到匹配的窗口/模型: ' + model, type: 'invalid_request_error' } });
  }
  const prompt = buildPrompt(messages);
  const requestId = 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  let text;
  try {
    text = await sendAndWait(ctx, requestId, prompt);
  } catch (err) {
    return sendJson(res, 504, { error: { message: (err && err.message) || '等待回复失败', type: 'server_error' } });
  }
  const fullText = typeof text === 'string' ? text : '';
  // 流式：网页版 AI 一次性返回整段，无法真逐字流；仍按 OpenAI SSE 格式发出（先等完整回复，再作为单个 chunk 发出）
  if (parsed.stream) {
    try {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const created = Math.floor(Date.now() / 1000);
      sendSse(res, {
        id: 'chatcmpl-' + requestId,
        object: 'chat.completion.chunk',
        created: created,
        model: model,
        choices: [{ index: 0, delta: { role: 'assistant', content: fullText }, finish_reason: null }],
      });
      sendSse(res, {
        id: 'chatcmpl-' + requestId,
        object: 'chat.completion.chunk',
        created: created,
        model: model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      try { res.end(); } catch (_) {}
    }
    return;
  }
  sendJson(res, 200, buildCompletion(requestId, model, fullText));
}

/** 路由分发 */
async function handleRequest(req, res) {
  try {
    let pathname = '/';
    try {
      const u = new URL(req.url, 'http://' + ((config && config.host) || '127.0.0.1'));
      pathname = u.pathname;
    } catch (_) { pathname = req.url || '/'; }
    if (req.method === 'GET' && pathname === '/v1/models') return handleModels(res);
    if (req.method === 'POST' && pathname === '/v1/chat/completions') return await handleChat(req, res);
    return sendJson(res, 404, { error: { message: 'Not found: ' + pathname, type: 'invalid_request_error' } });
  } catch (err) {
    console.error('[ApiServer] 请求处理异常:', err && err.message);
    return sendJson(res, 500, { error: { message: (err && err.message) || '内部错误', type: 'server_error' } });
  }
}

// ================= 生命周期 =================

/**
 * 启动服务
 * @param {object} [cfg] 可选覆盖配置
 * @returns {{success:boolean, port?:number, host?:string, error?:string}}
 */
function start(cfg) {
  if (server) return { success: true, already: true, port: config.port, host: config.host };
  config = Object.assign(readConfig(), cfg || {});
  try {
    server = http.createServer(handleRequest);
    server.on('error', (err) => {
      console.error('[ApiServer] 服务错误:', err && err.message);
      // 端口占用等错误：静默关闭，不影响主流程
      try { server.close(); } catch (_) {}
      server = null;
    });
    server.listen(config.port, config.host);
    console.log('[ApiServer] 已启动 http://' + config.host + ':' + config.port);
    return { success: true, port: config.port, host: config.host };
  } catch (err) {
    console.error('[ApiServer] 启动失败:', err && err.message);
    server = null;
    return { success: false, error: (err && err.message) || String(err) };
  }
}

/** 停止服务并清理所有挂起请求 */
function stop() {
  if (server) {
    try { server.close(); } catch (_) {}
    server = null;
  }
  for (const [, w] of waiting) {
    try { clearTimeout(w.timer); } catch (_) {}
    try { w.reject(new Error('服务已停止')); } catch (_) {}
  }
  waiting.clear();
  return { success: true };
}

/** 查询状态 */
function getStatus() {
  return {
    running: !!server,
    host: config ? config.host : null,
    port: config ? config.port : null,
    waiting: waiting.size,
  };
}

/**
 * 由 ipc 处理器调用：用网页 AI 的回复 resolve 对应等待中的请求
 * @returns {boolean} 是否有匹配的等待
 */
function resolveWait(requestId, text) {
  if (!requestId) return false;
  const w = waiting.get(requestId);
  if (!w) return false;
  waiting.delete(requestId);
  try { clearTimeout(w.timer); } catch (_) {}
  try { w.resolve(typeof text === 'string' ? text : ''); } catch (_) {}
  return true;
}

module.exports = {
  start,
  stop,
  getStatus,
  resolveWait,
  readConfig,
  writeConfig,
  DEFAULT_CONFIG,
};
