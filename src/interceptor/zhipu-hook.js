/**
 * 智谱清言（chatglm.cn）网络拦截器 —— 主世界注入脚本
 *
 * 用途：拦截 chatglm.cn 聊天流式接口（assistant/stream SSE），解析完整回复文本，
 *   通过 window 的 'tokfree-ai-response' CustomEvent 交给隔离世界处理。
 *   与 deepseek-hook.js / claude-hook.js / chatgpt-hook.js / qwen-hook.js 结构一致，
 *   由 src/preload/index.js 的 hookByProvider 白名单注入（非 provider 自注入）。
 *
 * 解析格式（官方逆向 nextai-translator chatglm.ts，2026-09）：
 *   - 帧 JSON：{ status: 'init', parts: [{ content: [{ type: 'text', text: '<全量累积>' }] }] }
 *   - 完成信号：event === 'finish'
 *   智谱每帧重发当前全量文本，故以最后一帧全量为准（覆盖式）。
 */
function zhipuHookSource() {
  return '(' + function zhipuHookInstaller() {
    var MARKER = '__tokfreeZhipuHookInstalled__';
    if (window[MARKER]) return;
    window[MARKER] = true;

    function dispatch(text, finished) {
      try {
        window.dispatchEvent(new CustomEvent('tokfree-ai-response', {
          detail: { text: text || '', finished: !!finished, tokenUsage: null }
        }));
      } catch (e) { /* ignore */ }
    }

    // 是否智谱聊天流式接口（兼容 /chatglm/backend-api/assistant/stream 与 v1 变体）
    function isStreamUrl(url) {
      if (!url) return false;
      try {
        var u = new URL(url, document.baseURI);
        return /(^|\.)chatglm\.cn$/i.test(u.hostname) && /assistant\/stream/i.test(u.pathname);
      } catch (e) {
        return /assistant\/stream/i.test(String(url));
      }
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

    // 拼接一帧内所有 part.content[].text（保持顺序），得到该帧的回复全量
    function collectText(obj) {
      var out = '';
      var parts = obj && obj.parts;
      if (!Array.isArray(parts)) return out;
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (!p || !Array.isArray(p.content)) continue;
        for (var j = 0; j < p.content.length; j++) {
          var it = p.content[j];
          if (it && typeof it.text === 'string') out += it.text;
        }
      }
      return out;
    }

    // 处理一帧 SSE：覆盖式全量（智谱每帧重发当前全量文本，以最后一帧全量为准）
    function handleFrame(block, st) {
      if (st.dispatched) return;
      var obj = parseBlock(block);
      if (!obj || typeof obj !== 'object') return;
      if (obj.event === 'finish') { st.finished = true; finishStream(st); return; }
      if (obj.status !== 'init') return;
      var full = collectText(obj);
      if (full) {
        st.text = full;
        st.len = full.length;
      }
    }

    function finishStream(st) {
      if (st.dispatched) return;
      if (st.text) {
        st.dispatched = true;
        console.log('[zhipu-hook] 回复完成，长度=' + st.text.length);
        console.log('[zhipu-hook] TEXT=' + JSON.stringify(st.text));
        dispatch(st.text, true);
      }
    }

    // ---------- fetch 拦截 ----------
    var origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        var url = (typeof input === 'string') ? input : (input && input.url) || '';
        if (isStreamUrl(url)) {
          try {
            var p = origFetch.apply(this, arguments);
            p.then(function (resp) {
              try {
                if (!resp || !resp.body) return;
                var cloned = resp.clone();
                var reader = cloned.body.getReader();
                var dec = new TextDecoder();
                var decoder = createFrameDecoder();
                var st = { text: '', len: 0, finished: false, dispatched: false };
                function pump() {
                  return reader.read().then(function (r) {
                    if (r.done) {
                      var tail = decoder.finish();
                      for (var i = 0; i < tail.length; i++) handleFrame(tail[i], st);
                      finishStream(st);
                      return;
                    }
                    var frames = decoder.push(dec.decode(r.value, { stream: true }));
                    for (var k = 0; k < frames.length; k++) handleFrame(frames[k], st);
                    return pump();
                  }).catch(function () { /* 流读取失败，忽略 */ });
                }
                pump();
              } catch (e) { /* ignore */ }
            }).catch(function () { /* ignore */ });
            return p;
          } catch (e) { /* fallthrough */ }
        }
        return origFetch.apply(this, arguments);
      };
    }

    // ---------- XHR 拦截（兜底，兼容智谱旧版请求方式） ----------
    try {
      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        this.__zhipuUrl = url;
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        var xhr = this;
        if (isStreamUrl(xhr.__zhipuUrl)) {
          var st = { text: '', len: 0, finished: false, dispatched: false, offset: 0, decoder: null };
          xhr.__zhipuState = st;
          xhr.addEventListener('readystatechange', function () {
            try {
              if (xhr.readyState < 3) return;
              var t = xhr.responseText || '';
              var chunk = t.slice(st.offset);
              st.offset = t.length;
              if (chunk) {
                if (!st.decoder) st.decoder = createFrameDecoder();
                var frames = st.decoder.push(chunk);
                for (var i = 0; i < frames.length; i++) handleFrame(frames[i], st);
              }
              if (xhr.readyState === 4) {
                if (st.decoder) {
                  var tail = st.decoder.finish();
                  for (var k = 0; k < tail.length; k++) handleFrame(tail[k], st);
                }
                finishStream(st);
              }
            } catch (e) { /* ignore */ }
          });
        }
        return origSend.apply(this, arguments);
      };
    } catch (e) { /* ignore */ }

    console.log('[zhipu-hook] 已安装（拦截 assistant/stream SSE）');
  }.toString() + ')();';
}

module.exports = { zhipuHookSource };
