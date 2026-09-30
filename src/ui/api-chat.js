/**
 * 本地聊天页逻辑（API 型 provider: api-openai）
 *
 * 约束：
 * - 不直接 fetch 外部 API（CORS），统一走 window.electronAPI.apiProviderRequest（主进程代理）
 * - 渲染符合 provider 选择器的 DOM：
 *     #api-chat-input / #api-chat-send / #api-chat-status[data-generating]
 *     消息节点 data-role="user"|"assistant"，AI 正文含 .markdown
 * - 代码块用标准 <pre><code class="language-xxx">
 * - 配置存 localStorage（webview 按 partition 隔离）
 */
(function () {
  'use strict';

  // ========== 配置 ==========
  var LS = {
    baseUrl: 'tokfree.apiChat.baseUrl',
    authKey: 'tokfree.apiChat.authKey',
    model: 'tokfree.apiChat.model',
    image: 'tokfree.apiChat.imageMode',
  };
  var DEFAULTS = {
    baseUrl: 'http://localhost:3000/v1',
    authKey: '',
    model: 'auto',
    image: false,
  };

  function lsGet(k, d) {
    try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (_) {} }

  var cfg = {
    baseUrl: lsGet(LS.baseUrl, DEFAULTS.baseUrl),
    authKey: lsGet(LS.authKey, DEFAULTS.authKey),
    model: lsGet(LS.model, DEFAULTS.model),
    image: lsGet(LS.image, DEFAULTS.image ? '1' : '0') === '1',
  };

  // ========== DOM ==========
  var elMessages = document.getElementById('api-chat-messages');
  var elInput = document.getElementById('api-chat-input');
  var elSend = document.getElementById('api-chat-send');
  var elStatus = document.getElementById('api-chat-status');
  var elBaseUrl = document.getElementById('api-chat-base-url');
  var elAuthKey = document.getElementById('api-chat-auth-key');
  var elModel = document.getElementById('api-chat-model');
  var elImageToggle = document.getElementById('api-chat-image-toggle');

  // 回填配置
  elBaseUrl.value = cfg.baseUrl;
  elAuthKey.value = cfg.authKey;
  elImageToggle.checked = !!cfg.image;
  // elModel 是 <select>，选项由 loadModels() 异步填充；先放当前值占位（保证兜底可用）
  ensureModelOption(cfg.model);

  elBaseUrl.addEventListener('input', function () {
    cfg.baseUrl = elBaseUrl.value.trim(); lsSet(LS.baseUrl, cfg.baseUrl);
    scheduleLoadModels();
  });
  elAuthKey.addEventListener('input', function () {
    cfg.authKey = elAuthKey.value.trim(); lsSet(LS.authKey, cfg.authKey);
    scheduleLoadModels();
  });
  elModel.addEventListener('change', function () { cfg.model = elModel.value; lsSet(LS.model, cfg.model); });
  elImageToggle.addEventListener('change', function () { cfg.image = !!elImageToggle.checked; lsSet(LS.image, cfg.image ? '1' : '0'); });

  // ========== 模型下拉 ==========
  // 确保 elModel 里存在某个值的 option，并选中它（用于兜底 / 保留当前选中）
  function ensureModelOption(val, label) {
    val = String(val == null ? '' : val);
    var opts = elModel.options;
    for (var i = 0; i < opts.length; i++) {
      if (opts[i].value === val) { elModel.value = val; return; }
    }
    var opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label != null ? label : val;
    elModel.appendChild(opt);
    elModel.value = val;
  }

  // 从 /models 拉取模型列表，填充下拉
  async function loadModels() {
    if (!hasApi || !hasApi()) return;
    var baseUrl = (cfg.baseUrl || '').trim();
    if (!baseUrl) return;
    try {
      var res = await window.electronAPI.apiProviderRequest({
        baseUrl: baseUrl,
        path: '/models',
        method: 'GET',
        authKey: cfg.authKey,
        stream: false,
      });
      var data = res;
      if (res && typeof res === 'object' && res.ok === false) throw new Error(res.error || '请求失败');
      if (res && typeof res === 'object' && res.data !== undefined) data = res.data;
      // 支持 {data:[{id}]} / {object:'list',data:[...]} / 直接数组
      var list = null;
      if (Array.isArray(data)) list = data;
      else if (data && Array.isArray(data.data)) list = data.data;
      var ids = [];
      if (list) {
        for (var i = 0; i < list.length; i++) {
          var item = list[i];
          var id = (item && typeof item === 'object') ? item.id : item;
          if (id) ids.push(String(id));
        }
      }
      if (!ids.length) throw new Error('未解析到模型列表');

      var prev = elModel.value || cfg.model;
      elModel.innerHTML = '';
      for (var j = 0; j < ids.length; j++) {
        var o = document.createElement('option');
        o.value = ids[j];
        o.textContent = ids[j];
        elModel.appendChild(o);
      }
      // 保留原选中：若不在列表则追加
      ensureModelOption(prev);
    } catch (err) {
      // 兜底：至少保留一个可用的 option，不破坏手动输入能力
      if (!elModel.options.length) ensureModelOption(cfg.model || 'auto', (cfg.model || 'auto') + '（加载失败）');
      console.warn('[api-chat] 加载模型列表失败:', (err && err.message) || err);
    }
  }

  // baseUrl / authKey 变更后防抖 500ms 重载
  var loadModelsTimer = null;
  function scheduleLoadModels() {
    if (loadModelsTimer) clearTimeout(loadModelsTimer);
    loadModelsTimer = setTimeout(loadModels, 500);
  }

  // ========== 状态 ==========
  function setGenerating(on, text) {
    elStatus.setAttribute('data-generating', on ? 'true' : 'false');
    elStatus.textContent = text || (on ? '生成中…' : '空闲');
    elSend.disabled = !!on;
  }

  // ========== 消息渲染 ==========
  function clearEmpty() {
    var empty = elMessages.querySelector('.api-empty');
    if (empty) empty.remove();
  }

  function addMessage(role) {
    clearEmpty();
    var node = document.createElement('div');
    node.className = 'api-msg api-msg-' + role;
    node.setAttribute('data-role', role);
    var md = document.createElement('div');
    md.className = 'markdown';
    node.appendChild(md);
    elMessages.appendChild(node);
    elMessages.scrollTop = elMessages.scrollHeight;
    return md;
  }

  function scrollBottom() { elMessages.scrollTop = elMessages.scrollHeight; }

  // ========== 极简 Markdown 渲染 ==========
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // 行内：code / img / bold，先转义
  function renderInline(raw) {
    var out = escapeHtml(raw);
    // 图片 ![alt](url)
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_m, alt, url) {
      return '<img alt="' + alt + '" src="' + url + '">';
    });
    // 行内代码 `code`
    out = out.replace(/`([^`]+)`/g, function (_m, c) { return '<code>' + c + '</code>'; });
    // 粗体 **x**
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return out;
  }

  // 完整 markdown → HTML（保留 fenced code block 的 pre>code.language-xxx）
  function renderMarkdown(text) {
    var lines = String(text == null ? '' : text).split('\n');
    var html = [];
    var inCode = false, codeLang = '', codeBuf = [];

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!inCode) {
        var fence = line.match(/^\s*```\s*([\w-]*)\s*$/);
        if (fence) {
          inCode = true; codeLang = (fence[1] || '').toLowerCase(); codeBuf = [];
          continue;
        }
        if (line.trim() === '') { html.push('<br>'); continue; }
        html.push('<div>' + renderInline(line) + '</div>');
      } else {
        var close = line.match(/^\s*```\s*$/);
        if (close) {
          var cls = codeLang ? ' class="language-' + codeLang + '"' : '';
          html.push('<pre><code' + cls + '>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
          inCode = false; codeLang = ''; codeBuf = [];
        } else {
          codeBuf.push(line);
        }
      }
    }
    // 未闭合的代码块也渲染出来（流式过程中常见）
    if (inCode) {
      var cls2 = codeLang ? ' class="language-' + codeLang + '"' : '';
      html.push('<pre><code' + cls2 + '>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
    }
    return html.join('');
  }

  function renderInto(mdEl, text) {
    mdEl.innerHTML = renderMarkdown(text);
    scrollBottom();
  }

  // ========== SSE 解析 ==========
  // 从可能的返回形态里取出「SSE 文本」
  function extractSseText(res) {
    if (res == null) return '';
    if (typeof res === 'string') return res;
    if (typeof res === 'object') {
      if (typeof res.streamText === 'string') return res.streamText;
      if (typeof res.text === 'string') return res.text;
      if (typeof res.data === 'string') return res.data;
      if (res.data && typeof res.data === 'object') return JSON.stringify(res.data);
      if (typeof res.body === 'string') return res.body;
    }
    return '';
  }

  // 累积流式增量：把 SSE 文本切成完整事件行，返回新增的正文片段
  function parseSseChunk(chunk, state) {
    state.buffer += chunk;
    var pieces = [];
    // 以换行切分，保留最后一个可能不完整的行
    var parts = state.buffer.split('\n');
    state.buffer = parts.pop() || '';

    for (var i = 0; i < parts.length; i++) {
      var line = parts[i].replace(/\r$/, '');
      if (!line || line.charAt(0) === ':') continue;
      if (line.indexOf('data:') !== 0) continue;
      var data = line.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') { state.done = true; continue; }
      try {
        var obj = JSON.parse(data);
        var delta = pickDelta(obj);
        if (delta) pieces.push(delta);
      } catch (_) { /* 忽略非 JSON 数据行 */ }
    }
    return pieces.join('');
  }

  // 兼容 chat/completions 与 responses 风格
  function pickDelta(obj) {
    if (!obj || typeof obj !== 'object') return '';
    if (obj.choices && obj.choices[0]) {
      var c = obj.choices[0];
      if (c.delta && typeof c.delta.content === 'string') return c.delta.content;
      if (c.message && typeof c.message.content === 'string') return c.message.content;
      if (typeof c.text === 'string') return c.text;
    }
    if (typeof obj.delta === 'string') return obj.delta;
    if (obj.delta && typeof obj.delta.text === 'string') return obj.delta.text;
    if (typeof obj.content === 'string') return obj.content;
    return '';
  }

  // 非流式响应：整个 JSON 里取正文
  function extractFullText(sseText) {
    var acc = '';
    var lines = String(sseText).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\r$/, '');
      if (line.indexOf('data:') !== 0) continue;
      var data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        var obj = JSON.parse(data);
        var d = pickDelta(obj);
        if (d) acc += d;
      } catch (_) {}
    }
    if (acc) return acc;
    // 退化成纯 JSON body
    try {
      var whole = JSON.parse(sseText);
      var t = pickDelta(whole);
      if (t) return t;
    } catch (_) {}
    return '';
  }

  // ========== 请求 ==========
  function hasApi() {
    return !!(window.electronAPI && typeof window.electronAPI.apiProviderRequest === 'function');
  }

  function buildMessages(history) {
    return history.map(function (m) { return { role: m.role, content: m.content }; });
  }

  // 会话历史（仅内存，供本次会话上下文）
  var history = [];

  async function sendChat(userText) {
    var md = addMessage('assistant');
    var state = { buffer: '', done: false };
    var acc = '';

    try {
      if (!hasApi()) {
        renderInto(md, '错误：未检测到 apiProviderRequest 接口（preload 未注入或主进程未接线）。');
        return;
      }
      var payload = {
        baseUrl: cfg.baseUrl,
        path: '/chat/completions',
        authKey: cfg.authKey,
        stream: true,
        body: {
          model: cfg.model,
          messages: buildMessages(history),
          stream: true,
        },
      };
      var res = await window.electronAPI.apiProviderRequest(payload);

      // 主进程可能返回 { ok, text } / { ok, error } / 直接字符串
      if (res && typeof res === 'object' && res.ok === false) {
        renderInto(md, '请求失败：' + (res.error || '未知错误'));
        return;
      }

      var sseText = extractSseText(res);
      if (!sseText) {
        renderInto(md, '后端无响应内容（请检查 Base URL / AuthKey / 模型名）。');
        return;
      }

      // 尝试流式逐段解析；若返回体不是 SSE（一次性 JSON），则整体取正文
      var isSse = /(^|\n)data:/.test(sseText);
      if (isSse) {
        var chunk = parseSseChunk(sseText, state);
        if (chunk) { acc += chunk; renderInto(md, acc); }
        if (!acc) {
          var full = extractFullText(sseText);
          if (full) { acc = full; renderInto(md, acc); }
        }
      } else {
        var full2 = extractFullText(sseText) || sseText;
        acc = full2;
        renderInto(md, acc);
      }

      if (!acc) {
        renderInto(md, '（空回复）');
      }
      if (acc) history.push({ role: 'assistant', content: acc });
    } catch (err) {
      renderInto(md, '请求异常：' + ((err && err.message) || String(err)));
    } finally {
      setGenerating(false);
    }
  }

  async function sendImage(prompt) {
    var md = addMessage('assistant');
    try {
      if (!hasApi()) {
        renderInto(md, '错误：未检测到 apiProviderRequest 接口。');
        return;
      }
      var res = await window.electronAPI.apiProviderRequest({
        baseUrl: cfg.baseUrl,
        path: '/images/generations',
        authKey: cfg.authKey,
        stream: false,
        body: { model: cfg.model, prompt: prompt, n: 1, response_format: 'b64_json' },
      });
      if (res && typeof res === 'object' && res.ok === false) {
        renderInto(md, '生图失败：' + (res.error || '未知错误'));
        return;
      }
      var text = extractSseText(res);
      var imgMd = '';
      try {
        var obj = JSON.parse(text);
        var item = obj && obj.data && obj.data[0];
        if (item) {
          if (item.url) imgMd = '![img](' + item.url + ')';
          else if (item.b64_json) imgMd = '![img](data:image/png;base64,' + item.b64_json + ')';
        }
      } catch (_) {}
      renderInto(md, imgMd || '生图返回无法解析：' + text);
    } catch (err) {
      renderInto(md, '生图异常：' + ((err && err.message) || String(err)));
    } finally {
      setGenerating(false);
    }
  }

  // ========== 发送入口 ==========
  var busy = false;
  async function submit() {
    if (busy) return;
    var text = (elInput.value || '').trim();
    if (!text) return;

    elInput.value = '';
    busy = true;
    setGenerating(true, cfg.image ? '生图中…' : '生成中…');

    // 渲染用户消息
    var userMd = addMessage('user');
    renderInto(userMd, text);
    history.push({ role: 'user', content: text });

    try {
      if (cfg.image) await sendImage(text);
      else await sendChat(text);
    } finally {
      busy = false;
      setGenerating(false);
    }
  }

  elSend.addEventListener('click', submit);
  elInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  });

  // 初始状态
  setGenerating(false);
  loadModels();

  // ========== 壳层桥接接口 ==========
  // 供壳层 shell.js 通过 execInActive 调用：壳层 #cv-input 发消息、Agent 视图读消息。
  // api-chat.html 不含网页端 TokFree 覆盖层，故需此桥接替代 #tokfree-user-input 通道。
  window.__tokfreeApiChat = {
    send: function (text) {
      if (typeof text === 'string' && text.trim()) {
        elInput.value = text;
        submit();
        return true;
      }
      return false;
    },
    getMessages: function () {
      var out = [];
      var nodes = document.querySelectorAll('#api-chat-messages [data-role]');
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var md = n.querySelector('.markdown');
        out.push({ role: n.getAttribute('data-role'), html: md ? md.innerHTML : '', text: md ? md.textContent : '' });
      }
      return out;
    },
    isReady: function () { return !!document.getElementById('api-chat-input'); },
    // 壳层保存配置后经 execInActive 调用，把配置同步进来（回填输入框 + 存 localStorage）
    setConfig: function (c) {
      if (!c || typeof c !== 'object') return false;
      if (typeof c.baseUrl === 'string') { cfg.baseUrl = c.baseUrl; lsSet(LS.baseUrl, cfg.baseUrl); if (elBaseUrl) elBaseUrl.value = cfg.baseUrl; }
      if (typeof c.authKey === 'string') { cfg.authKey = c.authKey; lsSet(LS.authKey, cfg.authKey); if (elAuthKey) elAuthKey.value = cfg.authKey; }
      if (typeof c.model === 'string') { cfg.model = c.model; lsSet(LS.model, cfg.model); try { ensureModelOption(c.model); } catch (_) {} }
      if (typeof c.image === 'boolean') { cfg.image = c.image; lsSet(LS.image, cfg.image ? '1' : '0'); if (elImageToggle) elImageToggle.checked = c.image; }
      return true;
    }
  };

  console.log('[api-chat] 本地聊天页已加载，provider=api-openai');
})();
