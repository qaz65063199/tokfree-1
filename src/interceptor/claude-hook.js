/**
 * Claude 请求拦截器（注入到页面主世界执行）
 * 被动观察 claude.ai 的 completion SSE 响应，提取 AI 回复文本，
 * 通过 window 的 'tokfree-ai-response' CustomEvent 交给隔离世界处理。
 * 仅旁路读取，不修改请求与响应。
 */
function claudeHookInstaller() {
  var MARKER = '__tokfreeClaudeHookInstalled__';
  if (window[MARKER]) return;
  window[MARKER] = true;

  // claude.ai 的 completion 端点形如：
  // /api/organizations/{org}/chat_conversations/{conv}/completion
  function isCompletion(url, method) {
    if (!url) return false;
    if (String(method || 'GET').toUpperCase() !== 'POST') return false;
    try {
      var u = new URL(url, document.baseURI);
      if (u.hostname.indexOf('claude.ai') === -1) return false;
      return /\/chat_conversations\/[^/]+\/(completion|retry_completion)$/.test(u.pathname);
    } catch (e) {
      return false;
    }
  }

  function dispatch(text, finished, interrupted) {
    try {
      window.dispatchEvent(new CustomEvent('tokfree-ai-response', {
        detail: { text: text || '', finished: !!finished, interrupted: !!interrupted }
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

  // ---------- 回复文本提取（Anthropic 流式事件格式）----------
  // 关注：
  //   content_block_delta + delta.type==='text_delta' → delta.text
  //   message_stop                                    → finished
  // 忽略 thinking_delta（思考内容）
  function createExtractor() {
    var text = '';
    var finished = false;
    var truncated = false;

    function consume(parsed) {
      if (!parsed || typeof parsed !== 'object') return;
      var type = parsed.type;
      if (type === 'content_block_delta' && parsed.delta) {
        var d = parsed.delta;
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          text += d.text;
        }
        // thinking_delta / signature_delta 忽略
        return;
      }
      // message_delta 携带 stop_reason（end_turn / max_tokens / stop_sequence / tool_use）
      if (type === 'message_delta' && parsed.delta) {
        if (parsed.delta.stop_reason === 'max_tokens') truncated = true;
        return;
      }
      if (type === 'message_stop') { finished = true; return; }
      if (type === 'error') { finished = true; return; }
    }

    return {
      consume: consume,
      get text() { return text; },
      get finished() { return finished; },
      get truncated() { return truncated; }
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
        dispatch(extractor.text, true, extractor.truncated);
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
          if (!dispatched) { dispatched = true; dispatch(extractor.text, true, !extractor.finished); }
          return;
        }
        feed(decoder.decode(r.value, { stream: true }));
        pump();
      }).catch(function () {
        if (!dispatched) { dispatched = true; dispatch(extractor.text, true, true); }
      });
    }
    pump();
  }

  // ---------- fetch 拦截 ----------
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input
        : (input && input.url) ? input.url
        : (input && input.href) ? input.href : '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      var p = origFetch.apply(this, arguments);
      if (!isCompletion(url, method)) return p;
      return p.then(function (response) {
        try {
          if (response && response.ok === false) {
            dispatchError({ reason: 'http', httpStatus: response.status });
          } else if (response && response.body) {
            observeBody(response.clone().body);
          }
        } catch (e) { /* ignore */ }
        return response;
      }, function (err) {
        dispatchError({ reason: 'network', name: err && err.name });
        throw err;
      });
    };
  }

  // ---------- XHR 拦截（被动读取 responseText）----------
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  var xhrInfo = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url) {
    try { xhrInfo.set(this, { url: url, method: method }); } catch (e) { /* ignore */ }
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var info = xhrInfo.get(this);
    if (info && isCompletion(info.url, info.method)) {
      try { observeXhr(this); } catch (e) { /* ignore */ }
    }
    return origSend.apply(this, arguments);
  };

  function observeXhr(xhr) {
    var lastLen = 0;
    var frameDecoder = createFrameDecoder();
    var extractor = createExtractor();
    var dispatched = false;

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
        dispatch(extractor.text, true, extractor.truncated);
      }
    }

    xhr.addEventListener('readystatechange', function () {
      if (xhr.readyState === 3 || xhr.readyState === 4) consumeChunk();
      if (xhr.readyState === 4 && !dispatched) {
        try {
          if (xhr.status && (xhr.status < 200 || xhr.status >= 300)) {
            dispatchError({ reason: 'http', httpStatus: xhr.status });
          }
        } catch (e) { /* ignore */ }
        var rest = frameDecoder.finish();
        for (var i = 0; i < rest.length; i++) {
          var parsed = parseBlock(rest[i]);
          if (parsed) extractor.consume(parsed);
        }
        dispatched = true;
        dispatch(extractor.text, true, !extractor.finished);
      }
    });
  }
}

function claudeHookSource() {
  return '(' + claudeHookInstaller.toString() + ')();';
}

module.exports = { claudeHookSource };
