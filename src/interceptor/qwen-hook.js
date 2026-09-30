/**
 * Qwen（chat.qwen.ai）请求拦截器（注入到页面主世界执行）
 *
 * 被动观察 /api/chat/completions 的 SSE 响应，提取 AI 回复正文，
 * 通过 window 的 'tokfree-ai-response' CustomEvent 交给隔离世界处理。
 * 仅旁路读取，不修改请求与响应。
 *
 * 实测流格式（POST /api/chat/completions，OpenAI 兼容 SSE）：
 *   data: {"choices":[{"delta":{"content":"文本","phase":"answer","status":"typing"}}]}
 *   data: {"response.created":{...}}                 → 会话/回复创建
 *   data: {"response.stopped":{...}}                 → 回复结束
 *   data: [DONE]                                     → 流结束
 *
 * 其中 phase 区分内容类型：
 *   answer（缺省）→ 正文；think / tool / web_search 等 → 非正文，不采纳
 */
function qwenHookInstaller() {
  var MARKER = '__tokfreeQwenHookInstalled__';
  if (window[MARKER]) return;
  window[MARKER] = true;

  // 正文 phase：缺省、answer、DeepThinking（深度思考模式的正文）
  var ANSWER_PHASES = ['answer', 'deepthinking'];
  // 明确不是正文的 phase：精确匹配
  var NOISE_EXACT = ['think', 'thinking_summary', 'keepalive', 'bio', 'slides'];
  // 明确不是正文的 phase：子串匹配
  var NOISE_SUBSTRINGS = [
    'tool', 'search', 'extractor', 'retriever', 'image', 'video',
    'audio', 'tts', 'speech', 'music', 'interrupt', 'interpreter', 'transl'
  ];

  function isCompletion(url, method) {
    if (!url) return false;
    if (String(method || 'GET').toUpperCase() !== 'POST') return false;
    try {
      var u = new URL(url, document.baseURI);
      var host = u.hostname;
      if (host && host.indexOf('qwen.ai') === -1) return false;
      // /api/chat/completions 或 /api/v2/chat/completions，不含 /stop
      return /^\/api\/(?:v\d+\/)?chat\/completions\/?$/.test(u.pathname);
    } catch (e) {
      return /\/api\/(?:v\d+\/)?chat\/completions\/?$/.test(String(url).split('?')[0]);
    }
  }

  function dispatch(text, finished, interrupted, tokenUsage) {
    try {
      window.dispatchEvent(new CustomEvent('tokfree-ai-response', {
        detail: {
          text: text || '',
          finished: !!finished,
          interrupted: !!interrupted,
          tokenUsage: tokenUsage || null
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

  // 返回 { data: string|null, done: boolean }
  function parseBlock(block) {
    if (!block || !block.trim()) return { data: null, done: false };
    var data = null;
    var lines = block.split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('data:') === 0) {
        var d = line.slice(5).trim();
        data = data == null ? d : data + '\n' + d;
      }
    }
    if (data == null) return { data: null, done: false };
    if (data === '[DONE]') return { data: null, done: true };
    return { data: data, done: false };
  }

  // ---------- 回复文本提取 ----------
  function createExtractor() {
    // answerText：确定为正文的内容（phase 缺省或 answer）
    // otherText：其余 phase 的内容，仅当正文为空时兜底使用
    var answerText = '';
    var otherText = '';
    var finished = false;
    var truncated = false;
    // 服务端 token 统计（Qwen 的 usage 帧含 input_tokens/output_tokens/total_tokens）
    var tokenUsage = null;

    // 捕获 usage 字段（可能出现在多帧，取最新值覆盖）
    function captureUsage(src) {
      if (!src || typeof src !== 'object') return;
      var u = src.usage;
      if (!u || typeof u !== 'object') return;
      if (!tokenUsage) tokenUsage = {};
      if (typeof u.total_tokens === 'number') tokenUsage.accumulatedTokens = u.total_tokens;
      if (typeof u.input_tokens === 'number') tokenUsage.inputTokens = u.input_tokens;
      if (typeof u.output_tokens === 'number') tokenUsage.outputTokens = u.output_tokens;
    }

    function isAnswerPhase(phase) {
      var p = String(phase === undefined || phase === null ? '' : phase).toLowerCase();
      return p === '' || ANSWER_PHASES.indexOf(p) !== -1;
    }

    function isNoisePhase(phase) {
      var p = String(phase || '').toLowerCase();
      if (!p) return false;
      if (NOISE_EXACT.indexOf(p) !== -1) return true;
      for (var i = 0; i < NOISE_SUBSTRINGS.length; i++) {
        if (p.indexOf(NOISE_SUBSTRINGS[i]) !== -1) return true;
      }
      return false;
    }

    function consume(parsed) {
      if (!parsed || typeof parsed !== 'object') return;

      // 出现新的回复创建帧：重置缓冲，避免与上一条回复拼接
      if (parsed['response.created']) {
        answerText = '';
        otherText = '';
        tokenUsage = null;
        return;
      }

      // token 用量：usage 帧（OpenAI 兼容）通常随最后一个内容帧或独立帧到达
      captureUsage(parsed);
      if (parsed['response.stopped']) { finished = true; return; }
      if (parsed.error) { finished = true; return; }

      var choice = null;
      var delta = null;
      try {
        choice = parsed.choices && parsed.choices[0] ? parsed.choices[0] : null;
        delta = choice ? choice.delta : null;
      } catch (e) { delta = null; choice = null; }
      // OpenAI 兼容的 finish_reason：length / max_tokens 表示被长度截断
      if (choice && (choice.finish_reason === 'length' || choice.finish_reason === 'max_tokens')) {
        truncated = true;
      }
      if (!delta) return;

      // 结束标记：status 为 error 无条件结束；
      // finished 仅在正文阶段（answer/deepthinking/缺省）才算整体结束，
      // thinking_summary/think 等思考阶段的 finished 只代表思考结束，不是整体结束。
      if (delta.status === 'error') finished = true;
      else if (delta.status === 'finished' && isAnswerPhase(delta.phase)) finished = true;

      var content = typeof delta.content === 'string' ? delta.content : '';
      // TTS 之类非文本负载不采纳
      if (!content) return;
      if (delta.tts) return;

      if (isAnswerPhase(delta.phase)) {
        answerText += content;
      } else if (!isNoisePhase(delta.phase)) {
        otherText += content;
      }
    }

    return {
      consume: consume,
      markDone: function () { finished = true; },
      get text() {
        var t = answerText.trim() ? answerText : otherText;
        return t;
      },
      get finished() { return finished; },
      get truncated() { return truncated; },
      get tokenUsage() { return tokenUsage; }
    };
  }

  function observeBody(body) {
    if (!body) return;
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var frameDecoder = createFrameDecoder();
    var extractor = createExtractor();
    var dispatched = false;

    function flushFrame(frame) {
      var r = parseBlock(frame);
      if (r.done) { extractor.markDone(); return; }
      if (r.data == null) return;
      var parsed;
      try { parsed = JSON.parse(r.data); } catch (e) { return; }
      extractor.consume(parsed);
    }

    function feed(chunk) {
      var frames = frameDecoder.push(chunk);
      for (var i = 0; i < frames.length; i++) flushFrame(frames[i]);
      if (extractor.finished && !dispatched) {
        dispatched = true;
        dispatch(extractor.text, true, extractor.truncated, extractor.tokenUsage);
      }
    }

    function pump() {
      reader.read().then(function (r) {
        if (r.done) {
          var tail = decoder.decode();
          if (tail) feed(tail);
          var rest = frameDecoder.finish();
          for (var i = 0; i < rest.length; i++) flushFrame(rest[i]);
          if (!dispatched) { dispatched = true; dispatch(extractor.text, true, !extractor.finished, extractor.tokenUsage); }
          return;
        }
        feed(decoder.decode(r.value, { stream: true }));
        pump();
      }).catch(function () {
        if (!dispatched) { dispatched = true; dispatch(extractor.text, true, true, extractor.tokenUsage); }
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

    function flushFrame(frame) {
      var r = parseBlock(frame);
      if (r.done) { extractor.markDone(); return; }
      if (r.data == null) return;
      var parsed;
      try { parsed = JSON.parse(r.data); } catch (e) { return; }
      extractor.consume(parsed);
    }

    function consumeChunk() {
      var raw;
      try { raw = xhr.responseText; } catch (e) { return; }
      if (typeof raw !== 'string' || raw.length <= lastLen) return;
      var chunk = raw.slice(lastLen);
      lastLen = raw.length;
      var frames = frameDecoder.push(chunk);
      for (var i = 0; i < frames.length; i++) flushFrame(frames[i]);
      if (extractor.finished && !dispatched) {
        dispatched = true;
        dispatch(extractor.text, true, extractor.truncated, extractor.tokenUsage);
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
        for (var i = 0; i < rest.length; i++) flushFrame(rest[i]);
        dispatched = true;
        dispatch(extractor.text, true, !extractor.finished, extractor.tokenUsage);
      }
    });
  }
}

function qwenHookSource() {
  return '(' + qwenHookInstaller.toString() + ')();';
}

module.exports = { qwenHookSource };
