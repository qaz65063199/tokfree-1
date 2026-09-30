/**
 * DeepSeek 请求拦截器（注入到页面主世界执行）
 * 被动观察 /api/v0/chat/completion 的 SSE 响应，提取 AI 回复文本，
 * 通过 window 的 'tokfree-ai-response' CustomEvent 交给隔离世界处理。
 * 仅旁路读取，不修改请求与响应。
 */
function deepseekHookInstaller() {
  var MARKER = '__tokfreeDeepseekHookInstalled__';
  if (window[MARKER]) return;
  window[MARKER] = true;

  var COMPLETION_PATH = '/api/v0/chat/completion';
  var STOP_STREAM_PATH = '/api/v0/chat/stop_stream';
  // 用户主动停止标志：拦截到 stop_stream 请求时置位，新的 completion 开始时复位
  var userStopped = false;

  function isStopStream(url, method) {
    if (!url) return false;
    if (String(method || 'GET').toUpperCase() !== 'POST') return false;
    try {
      var u = new URL(url, document.baseURI);
      return u.pathname === STOP_STREAM_PATH;
    } catch (e) {
      return String(url).indexOf(STOP_STREAM_PATH) !== -1;
    }
  }

  function getSessionIdFromUrl() {
    try {
      var m = String(location.href).match(/\/chat\/s\/([a-f0-9-]+)/i);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }

  function isCompletion(url, method) {
    if (!url) return false;
    if (String(method || 'GET').toUpperCase() !== 'POST') return false;
    try {
      var u = new URL(url, document.baseURI);
      return u.pathname === COMPLETION_PATH;
    } catch (e) {
      return String(url).indexOf(COMPLETION_PATH) !== -1;
    }
  }

  function dispatch(text, finished, interrupted, tokenUsage, msgIds, bizCode) {
    try {
      // 终态判定：finished / stopped(用户停止) / error
      var status = finished ? 'finished' : ((interrupted || userStopped) ? 'stopped' : 'error');
      window.dispatchEvent(new CustomEvent('tokfree-ai-response', {
        detail: {
          text: text || '',
          finished: !!finished,
          interrupted: !!interrupted,
          userStopped: !!userStopped,
          status: status,
          tokenUsage: tokenUsage || null,
          msgIds: msgIds || null,
          bizCode: (bizCode === undefined ? null : bizCode)
        }
      }));
    } catch (e) { /* ignore */ }
  }

  // 派发错误事件（供重试引擎）
  function dispatchError(detail) {
    try {
      window.dispatchEvent(new CustomEvent('tokfree-ai-error', { detail: detail || {} }));
    } catch (e) { /* ignore */ }
  }

  // ---------- SSE 帧解码 ----------
  function createFrameDecoder() {
    var buffer = '', scanFrom = 0;
    return {
      push: function (text) {
        buffer += text;
        var frames = [], re = /\r?\n\r?\n/g, offset = 0, m;
        re.lastIndex = scanFrom;
        while ((m = re.exec(buffer)) !== null) {
          frames.push(buffer.slice(offset, m.index));
          offset = m.index + m[0].length;
        }
        buffer = buffer.slice(offset);
        scanFrom = Math.max(0, buffer.length - 3);
        return frames;
      },
      finish: function () {
        var frames = [];
        if (buffer) frames.push(buffer);
        buffer = ''; scanFrom = 0;
        return frames;
      }
    };
  }

  function parseBlock(block) {
    if (!block || !block.trim()) return null;
    var data = null;
    var lines = block.split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('data:') === 0) {
        var d = line.slice(5).trim();
        data = data == null ? d : data + '\n' + d;
      }
    }
    if (data == null) return null;
    try { return JSON.parse(data); } catch (e) { return null; }
  }

  // ---------- 回复文本提取（区分 THINK / RESPONSE 片段）----------
  function createExtractor() {
    var fragmentTypes = [];
    var currentIndex = -1;
    var observed = false;
    var text = '';
    var finished = false;
    var truncated = false;
    // 服务端权威 token 统计（accumulated_token_usage 含 prompt/context + 输出）
    var tokenUsage = null;
    // 业务码（限流等错误，如 40029=操作过于频繁）
    var bizCode = null;
    // 本条回复的消息 id：requestMessageId（用户提问）+ responseMessageId（AI 回复）
    // 供上下文压缩时定位摘要消息使用
    var msgIds = null;

    // 从对象里捕获消息 id 字段
    function captureMsgIds(src) {
      if (!src || typeof src !== 'object') return;
      if (!msgIds) msgIds = {};
      if (typeof src.request_message_id === 'number') msgIds.requestMessageId = src.request_message_id;
      if (typeof src.response_message_id === 'number') msgIds.responseMessageId = src.response_message_id;
      // 快照形式：{v:{response:{message_id, parent_id}}}
      if (typeof src.message_id === 'number') msgIds.responseMessageId = src.message_id;
      if (typeof src.parent_id === 'number') msgIds.requestMessageId = src.parent_id;
    }

    // 从对象里捕获 token 相关字段（幂等，只保留最后一次值）
    function captureTokenUsage(src) {
      if (!src || typeof src !== 'object') return;
      var changed = false;
      if (!tokenUsage) tokenUsage = {};
      if (typeof src.accumulated_token_usage === 'number') {
        tokenUsage.accumulatedTokens = src.accumulated_token_usage; changed = true;
      }
      if (typeof src.inserted_at === 'number') {
        tokenUsage.insertedAt = src.inserted_at; changed = true;
      }
      if (typeof src.updated_at === 'number') {
        tokenUsage.updatedAt = src.updated_at; changed = true;
      }
      if (typeof src.model_type === 'string') {
        tokenUsage.modelType = src.model_type; changed = true;
      }
      if (!changed && Object.keys(tokenUsage).length === 0) tokenUsage = null;
    }

    function lastSeg(p) { return typeof p === 'string' ? p.split('/').pop() : ''; }
    function isTextPatch(p) {
      var s = lastSeg(p);
      return s === 'content' || s === 'text' || s === 'markdown' || s === 'delta';
    }
    function isResponsePatch(p) {
      return typeof p === 'string' && (p === 'response' || p.indexOf('response/') === 0);
    }
    function isResponseTextPatch(p) { return isTextPatch(p) && isResponsePatch(p); }
    function isThinkingPatch(p) {
      var s = lastSeg(p);
      return s === 'reasoning_content' || s === 'thinking_content';
    }
    function isFragmentsAppend(p) {
      return p && typeof p.p === 'string' && p.p.slice(-10) === '/fragments' &&
        p.o === 'APPEND' && Array.isArray(p.v);
    }
    function snapshotFragments(p) {
      if (!p || p.p !== undefined || !p.v || typeof p.v !== 'object') return null;
      var r = p.v.response;
      if (!r || typeof r !== 'object') return null;
      var f = r.fragments;
      return Array.isArray(f) && f.length > 0 ? f : null;
    }
    function fragText(f) {
      if (!f || typeof f !== 'object') return '';
      if (typeof f.content === 'string') return f.content;
      if (typeof f.text === 'string') return f.text;
      return '';
    }
    function typeAt(i) {
      if (i === -1) i = currentIndex;
      if (i < 0 || i >= fragmentTypes.length) return null;
      return fragmentTypes[i];
    }
    function isThink(t) { return String(t).toUpperCase() === 'THINK'; }
    function consumeFragmentContent(fragments, types) {
      for (var i = 0; i < fragments.length; i++) {
        var c = fragText(fragments[i]);
        if (!c) continue;
        if (!isThink(types[i])) text += c;
      }
    }

    function consume(parsed) {
      if (!parsed || typeof parsed !== 'object') return;
      // 通用截断信号：finish_reason 为 length / max_tokens
      var fr = parsed.finish_reason || (parsed.v && typeof parsed.v === 'object' && parsed.v.finish_reason);
      if (fr === 'length' || fr === 'max_tokens') truncated = true;
      // 业务码识别：限流等错误可能以帧内 code 形式出现（如 40029=操作过于频繁）
      if (parsed.code !== undefined && parsed.code !== null) bizCode = parsed.code;
      if (parsed.error && typeof parsed.error === 'object' && parsed.error.code !== undefined && parsed.error.code !== null) bizCode = parsed.error.code;
      if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
        for (var i = 0; i < parsed.v.length; i++) consume(parsed.v[i]);
        return;
      }
      // ---- 消息 id 捕获 ----
      // 顶层帧：{"request_message_id":668,"response_message_id":669,...}
      captureMsgIds(parsed);
      // ---- token 字段捕获 ----
      // 1) 消息快照：{"v":{"response":{"accumulated_token_usage":...}}}
      if (parsed.v && typeof parsed.v === 'object' && parsed.v.response && typeof parsed.v.response === 'object') {
        captureTokenUsage(parsed.v.response);
        captureMsgIds(parsed.v.response);
      }
      // 2) 独立帧：{"p":"accumulated_token_usage","v":123}
      if (typeof parsed.p === 'string' && lastSeg(parsed.p) === 'accumulated_token_usage' && typeof parsed.v === 'number') {
        captureTokenUsage({ accumulated_token_usage: parsed.v });
      }
      // 3) 顶层 updated_at：{"updated_at":1789351765.04}
      if (parsed.updated_at !== undefined) {
        captureTokenUsage(parsed);
      }
      if (isFragmentsAppend(parsed)) {
        var types = [];
        for (var j = 0; j < parsed.v.length; j++) {
          types.push(String((parsed.v[j] && parsed.v[j].type) || 'RESPONSE'));
        }
        for (var ti = 0; ti < types.length; ti++) fragmentTypes.push(types[ti]);
        currentIndex = fragmentTypes.length - 1;
        observed = true;
        consumeFragmentContent(parsed.v, types);
        return;
      }
      var snap = snapshotFragments(parsed);
      if (snap) {
        var first = !observed;
        var stypes = [];
        for (var k = 0; k < snap.length; k++) {
          stypes.push(String((snap[k] && snap[k].type) || 'RESPONSE'));
        }
        fragmentTypes = stypes;
        currentIndex = fragmentTypes.length - 1;
        observed = true;
        if (first) consumeFragmentContent(snap, stypes);
        return;
      }
      if (isThinkingPatch(parsed.p) && typeof parsed.v === 'string') return;
      if (typeof parsed.p === 'string' && isResponseTextPatch(parsed.p) && typeof parsed.v === 'string') {
        var m = /^response\/fragments\/(-?\d+)\//.exec(parsed.p);
        var idx = m ? Number(m[1]) : -1;
        if (!isThink(typeAt(idx))) text += parsed.v;
        return;
      }
      if (parsed.p === undefined && typeof parsed.v === 'string') {
        if (!isThink(typeAt(currentIndex))) text += parsed.v;
        return;
      }
      if (parsed.p === 'response/status' && parsed.v === 'FINISHED') finished = true;
      else if (parsed.p === 'quasi_status' && parsed.v === 'FINISHED') finished = true;
    }

    return {
      consume: consume,
      get text() { return text; },
      get finished() { return finished; },
      get truncated() { return truncated; },
      get tokenUsage() { return tokenUsage; },
      get msgIds() { return msgIds; },
      get bizCode() { return bizCode; }
    };
  }

  function observeBody(body) {
    if (!body) return;
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var frameDecoder = createFrameDecoder();
    var extractor = createExtractor();
    var dispatched = false;

    function feed(chunk) {
      var frames = frameDecoder.push(chunk);
      for (var i = 0; i < frames.length; i++) {
        var parsed = parseBlock(frames[i]);
        if (parsed) extractor.consume(parsed);
      }
      if (extractor.finished && !dispatched) {
        dispatched = true;
        dispatch(extractor.text, true, extractor.truncated, extractor.tokenUsage, extractor.msgIds, extractor.bizCode);
      }
    }

    function pump() {
      reader.read().then(function (r) {
        if (r.done) {
          var tail = decoder.decode();
          if (tail) feed(tail);
          var rest = frameDecoder.finish();
          for (var i = 0; i < rest.length; i++) {
            var parsed = parseBlock(rest[i]);
            if (parsed) extractor.consume(parsed);
          }
          if (!dispatched) { dispatched = true; dispatch(extractor.text, true, !extractor.finished, extractor.tokenUsage, extractor.msgIds, extractor.bizCode); }
          return;
        }
        feed(decoder.decode(r.value, { stream: true }));
        pump();
      }).catch(function () {
        if (!dispatched) { dispatched = true; dispatch(extractor.text, true, true, extractor.tokenUsage, extractor.msgIds, extractor.bizCode); }
      });
    }
    pump();
  }

  // ---------- 缓存真实请求头（供上下文压缩时直接 fetch 分享接口）----------
  // DeepSeek 的 share/create 需要 authorization + x-client-* 头，
  // 拦截任意请求时缓存最新一组，供后续直接调用 API。
  var lastHeadersJson = null;
  function cacheHeaders(hdrs) {
    try {
      if (!hdrs) return;
      var lower = {};
      for (var k in hdrs) {
        if (Object.prototype.hasOwnProperty.call(hdrs, k)) {
          lower[String(k).toLowerCase()] = hdrs[k];
        }
      }
      if (!lower['authorization']) return;
      var json = JSON.stringify(lower);
      // 高频调用：内容未变时跳过 localStorage 写入（性能优化）
      if (json === lastHeadersJson) return;
      lastHeadersJson = json;
      localStorage.setItem('tokfree-ds-headers', json);
    } catch (e) { /* ignore */ }
  }

  // ---------- fetch 拦截 ----------
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input
        : (input && input.url) ? input.url
        : (input && input.href) ? input.href : '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      // 缓存请求头
      try {
        if (init && init.headers) {
          var h = init.headers;
          var obj = {};
          if (typeof h.forEach === 'function' && !Array.isArray(h)) { h.forEach(function (v, k) { obj[k] = v; }); }
          else if (Array.isArray(h)) { h.forEach(function (p) { obj[p[0]] = p[1]; }); }
          else { obj = h; }
          cacheHeaders(obj);
        }
      } catch (e) { /* ignore */ }
      var p = origFetch.apply(this, arguments);
      if (isStopStream(url, method)) {
        userStopped = true;
        console.log('[TokFree][hook] 检测到 stop_stream(fetch)，标记用户停止');
        return p;
      }
      if (!isCompletion(url, method)) return p;
      userStopped = false; // 新的 completion 开始：复位用户停止标志
      var fetchSessionId = getSessionIdFromUrl();
      return p.then(function (response) {
        try {
          if (response && response.ok === false) {
            var errDetail = { reason: 'http', httpStatus: response.status, sessionId: fetchSessionId };
            // 尝试从 body 解析业务码（如 40029 限流），异步且容错
            try {
              response.clone().text().then(function (t) {
                try {
                  var j = JSON.parse(t);
                  var code = j && (j.code !== undefined ? j.code : (j.error && j.error.code));
                  if (code !== undefined && code !== null) errDetail.bizCode = code;
                } catch (_) {}
                dispatchError(errDetail);
              }).catch(function () { dispatchError(errDetail); });
            } catch (_) { dispatchError(errDetail); }
          } else if (response && response.body) {
            observeBody(response.clone().body);
          }
        } catch (e) { /* ignore */ }
        return response;
      }, function (err) {
        dispatchError({ reason: 'network', name: err && err.name, sessionId: fetchSessionId });
        throw err;
      });
    };
  }

  // ---------- XHR 拦截（被动读取 responseText）----------
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  var origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  var xhrInfo = new WeakMap();
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      var inf = xhrInfo.get(this) || {};
      if (!inf.headers) inf.headers = {};
      inf.headers[name] = value;
      xhrInfo.set(this, inf);
      cacheHeaders(inf.headers);
    } catch (e) { /* ignore */ }
    return origSetRequestHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.open = function (method, url) {
    try { xhrInfo.set(this, { url: url, method: method }); } catch (e) { /* ignore */ }
    // 拦截 stop_stream：用户主动停止的直接证据
    try {
      if (isStopStream(url, method)) {
        userStopped = true;
        console.log('[TokFree][hook] 检测到 stop_stream(XHR)，标记用户停止');
      }
    } catch (e) { /* ignore */ }
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var info = xhrInfo.get(this);
    if (info && isCompletion(info.url, info.method)) {
      userStopped = false; // 新的 completion 开始：复位
      try { observeXhr(this); } catch (e) { /* ignore */ }
    }
    return origSend.apply(this, arguments);
  };

  function observeXhr(xhr) {
    var lastLen = 0;
    var frameDecoder = createFrameDecoder();
    var extractor = createExtractor();
    var dispatched = false;
    var reqSessionId = getSessionIdFromUrl();

    function consumeChunk() {
      var raw;
      try { raw = xhr.responseText; } catch (e) { return; }
      if (typeof raw !== 'string' || raw.length <= lastLen) return;
      var chunk = raw.slice(lastLen);
      lastLen = raw.length;
      var frames = frameDecoder.push(chunk);
      for (var i = 0; i < frames.length; i++) {
        var parsed = parseBlock(frames[i]);
        if (parsed) extractor.consume(parsed);
      }
      if (extractor.finished && !dispatched) {
        dispatched = true;
        dispatch(extractor.text, true, extractor.truncated, extractor.tokenUsage, extractor.msgIds, extractor.bizCode);
      }
    }

    xhr.addEventListener('readystatechange', function () {
      if (xhr.readyState === 3 || xhr.readyState === 4) consumeChunk();
      if (xhr.readyState === 4 && !dispatched) {
        // 非 2xx → 派发错误事件
        try {
          if (xhr.status && (xhr.status < 200 || xhr.status >= 300)) {
            var xd = { reason: 'http', httpStatus: xhr.status, sessionId: reqSessionId };
            try {
              var xj = JSON.parse(xhr.responseText);
              var xc = xj && (xj.code !== undefined ? xj.code : (xj.error && xj.error.code));
              if (xc !== undefined && xc !== null) xd.bizCode = xc;
            } catch (_) {}
            dispatchError(xd);
          }
        } catch (e) { /* ignore */ }
        var rest = frameDecoder.finish();
        for (var i = 0; i < rest.length; i++) {
          var parsed = parseBlock(rest[i]);
          if (parsed) extractor.consume(parsed);
        }
        dispatched = true;
        dispatch(extractor.text, true, !extractor.finished, extractor.tokenUsage, extractor.msgIds, extractor.bizCode);
      }
    });
  }
}

function deepseekHookSource() {
  return '(' + deepseekHookInstaller.toString() + ')();';
}

module.exports = { deepseekHookSource };

