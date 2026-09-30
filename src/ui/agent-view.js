/**
 * TokFree 壳层 Agent 视图（WorkBuddy 风格对话界面）
 *
 * 把网页版聊天界面"盖"在下方，壳层以 Agent 风格重新呈现会话：
 *   - 用户消息气泡（右对齐，无图标）
 *   - AI 消息统一 AI 图标（左对齐）
 *   - AI 思考块（可折叠）
 *   - 工具步骤：执行中转圈动画 / 完成后折叠为一行
 *   - AI 最终叙述（渲染后的富文本）
 * 数据来自 webview 内 electronAPI.extractConversation() 的只读提取，
 * 网页照常运行，只是不再直接展示。
 *
 * 本模块不直接碰 webview：所有跨页调用通过 init() 注入的回调完成。
 * 样式在本模块内自注入 <style>（幂等），不写进 shell.css。
 */
window.AgentView = (function () {
  'use strict';

  var els = {};
  var opts = {};
  var lastSig = '';
  var refreshing = false;
  var visible = false;
  // 需求4：按会话累积历史消息，避免 DeepSeek 虚拟滚动丢节点导致历史被覆盖
  // 需求3：缓存键升级为 profileId + sessionId，切标签时按 profile 切换缓存上下文（切换即时出内容）
  var historyByKey = {};
  var lastKeyByProfile = {};
  var activeProfileId = '';
  var curSessionId = '';
  var MAX_HISTORY = 400;
  // 时间：本地记录每条消息「首次看到」的时间（DeepSeek DOM 不提供逐条时间戳）。
  // key = profileId+sessionId + '\u0002' + timeSig；值 0 = 历史消息（不显示时间），>0 = 首次看到的时间戳（ms）。
  var firstSeenMap = {};
  var firstSeenCount = 0;
  var MAX_FIRSTSEEN = 4000;
  var baselineKeys = {};
  // 需求1：AI 运行标志（由 shell.js 依据 webview 内 #tokfree-task-status 可见性同步）。
  // 与 data.generating 取或：任一为真都显示「AI 正在运行中」提示条。
  var runningFlag = false;
  var lastGenerating = false;

  // 统一 AI 图标（内联 SVG，紫罗兰主题色）
  var AI_AVATAR_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="11" rx="3"></rect><circle cx="9" cy="13.5" r="1.15" fill="currentColor" stroke="none"></circle><circle cx="15" cy="13.5" r="1.15" fill="currentColor" stroke="none"></circle><path d="M12 8V4.5"></path><circle cx="12" cy="3.2" r="1.2" fill="currentColor" stroke="none"></circle></svg>';

  // 用户（TF 品牌）头像：与左侧栏品牌 logo 同款（44x44 紫罗兰渐变 + 白色 TF 字形）
  var TF_USER_SVG = '<svg viewBox="0 0 44 44" width="24" height="24" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="tfUserGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c6cff"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs><rect width="44" height="44" rx="11" fill="url(#tfUserGrad)"/><path d="M9 13.5 H22 V16.8 H17.3 V30.5 H14 V16.8 H9 Z" fill="#fff"/><path d="M25 13.5 H35 V16.8 H28.3 V20.8 H33.5 V24.1 H28.3 V30.5 H25 Z" fill="#fff"/></svg>';

  function $(id) { return document.getElementById(id); }

  /** 注入模块样式（幂等，id 固定 tokfree-agent-view-style） */
  function injectStyle() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('tokfree-agent-view-style')) return;
    var style = document.createElement('style');
    style.id = 'tokfree-agent-view-style';
    style.textContent = [
      '.cv-ai { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 10px; }',
      '.cv-ai-avatar { flex: 0 0 auto; width: 26px; height: 26px; margin-top: 2px; border-radius: 8px; background: linear-gradient(135deg, var(--accent, #7c6cff), #a78bfa); color: #fff; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 8px rgba(124,108,255,0.35); }',
      '.cv-ai-inner { flex: 1 1 auto; min-width: 0; }',
      '.cv-steps-done { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; padding: 7px 12px; font-size: 12px; color: var(--text-2, #9298b8); background: var(--panel, #1b1d2b); border: 1px solid var(--border, #2a2d40); border-radius: 10px; }',
      '.cv-steps-check { color: var(--ok, #4ade80); font-weight: 700; }',
      '.cv-steps-running { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; padding: 8px 12px; font-size: 12px; font-weight: 600; color: var(--accent, #7c6cff); background: var(--panel, #1b1d2b); border: 1px solid var(--border, #2a2d40); border-radius: 10px; }',
      '.cv-user-collapse { margin: 0; }',
      '.cv-user-collapse-body { white-space: pre-wrap; word-break: break-word; }',
      '.cv-user-receipt-collapse { margin: 0; }',
      '.cv-user-receipt-collapse summary { cursor: pointer; font-size: 12px; color: var(--text-2, #9298b8); list-style: none; }',
      '.cv-receipt-body { margin: 8px 0 0; white-space: pre-wrap; word-break: break-word; font-family: Consolas, Menlo, monospace; font-size: 11px; color: var(--text-2, #9298b8); background: var(--panel, #1b1d2b); border: 1px solid var(--border, #2a2d40); border-radius: 8px; padding: 8px 10px; max-height: 260px; overflow: auto; }',
      '.cv-steps-spinner { flex: 0 0 auto; width: 12px; height: 12px; border-radius: 50%; border: 2px solid rgba(124,108,255,0.25); border-top-color: var(--accent, #7c6cff); animation: cv-av-spin 0.8s linear infinite; }',
      '@keyframes cv-av-spin { to { transform: rotate(360deg); } }',
      '.cv-ai-code { margin: 8px 0; }',
      '.cv-ai-code summary { cursor: pointer; color: var(--text-2, #9298b8); font-size: 12px; padding: 6px 10px; background: var(--panel, #1b1d2b); border: 1px solid var(--border, #2a2d40); border-radius: 8px; list-style: none; }',
      '.cv-ai-code[open] summary { margin-bottom: 8px; }',
      '.cv-ai-code pre { margin: 0; }',
      '.cv-user-atts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }',
      '.cv-user-atts:first-child { margin-top: 0; }',
      '.cv-user-img { margin: 0; display: inline-block; }',
      '.cv-user-img summary { list-style: none; cursor: pointer; display: inline-block; }',
      '.cv-user-img summary::-webkit-details-marker { display: none; }',
      '.cv-user-thumb { max-width: 180px; max-height: 180px; border-radius: 8px; display: block; border: 1px solid var(--border, #2a2d40); }',
      '.cv-user-img[open] .cv-user-thumb { max-width: 120px; max-height: 120px; }',
      '.cv-user-img-full { max-width: 100%; margin-top: 6px; border-radius: 8px; display: block; }',
      '.cv-user-file { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 3px 10px; font-size: 12px; background: var(--panel, #1b1d2b); border: 1px solid var(--border-strong, #2a2d40); border-radius: 999px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.cv-ai-body img { cursor: zoom-in; max-width: 100%; }',
      '#cv-img-lightbox { position: fixed; inset: 0; z-index: 99999; background: rgba(0,0,0,.85); display: flex; align-items: center; justify-content: center; }',
      '#cv-img-lightbox.cv-hidden { display: none; }',
      '#cv-img-lightbox img { max-width: 92vw; max-height: 92vh; object-fit: contain; border-radius: 8px; box-shadow: 0 12px 48px rgba(0,0,0,.6); cursor: default; }',
      '#cv-img-lightbox-save { position: fixed; top: 18px; right: 22px; z-index: 100000; padding: 8px 16px; font-size: 13px; font-weight: 600; color: #fff; background: var(--accent, #7c6cff); border: none; border-radius: 8px; cursor: pointer; }',
      '#cv-img-lightbox-save:hover { filter: brightness(1.1); }',
      '#cv-img-lightbox-save:disabled { opacity: .7; cursor: default; }',
    ].join(String.fromCharCode(10));
    (document.head || document.documentElement).appendChild(style);
  }

  /**
   * 需求2：把用户消息里的三反引号代码块默认折叠为 <details>，
   * 普通文本原样转义（气泡已 white-space:pre-wrap）。
   */
  function renderUserText(text) {
    var s = String(text == null ? '' : text);
    var re = /\`\`\`([^\n`]*)\n?([\s\S]*?)\`\`\`/g;
    var out = '';
    var last = 0;
    var m;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) out += escapeHtml(s.slice(last, m.index));
      var lang = (m[1] || '').trim();
      var code = m[2] || '';
      var label = lang ? ('已折叠的代码（' + escapeHtml(lang) + '）') : '已折叠的代码（点击展开）';
      out += '<details class="cv-user-code"><summary>▸ ' + label + '</summary>' +
        '<pre><code>' + escapeHtml(code) + '</code></pre></details>';
      last = m.index + m[0].length;
    }
    if (last < s.length) out += escapeHtml(s.slice(last));
    var inner = out || escapeHtml(s);

    // 需求2：超长用户消息（直接粘贴的长文本/代码，无三反引号包裹）整体折叠，
    // 避免占满整屏。阈值：字符数 > 600 或 行数 > 12。短消息原样返回不受影响。
    var lineCount = s.length ? s.split('\n').length : 0;
    if (s.length > 600 || lineCount > 12) {
      return '<details class="cv-user-code cv-user-collapse"><summary>▸ ' +
        '已折叠的长内容（共 ' + lineCount + ' 行，点击展开）</summary>' +
        '<div class="cv-user-collapse-body">' + inner + '</div></details>';
    }
    return inner;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 把工具回执（kind === 'receipt'）折叠为 <details>，避免占满整屏。
   * 完整文本用 escapeHtml 转义，CSS white-space:pre-wrap 保留换行。
   */
  function renderReceiptFold(text) {
    var s = String(text == null ? '' : text);
    return '<details class="cv-user-receipt-collapse"><summary>▸ JS 执行结果</summary>' +
      '<pre class="cv-receipt-body">' + escapeHtml(s) + '</pre></details>';
  }

  /**
   * 渲染用户消息里的附件：
   *   - 图片：缩略图（点击展开大图），无 dataURL 时降级为「🖼 图片」
   *   - 文件：图标 + 文件名
   * @param {Array<{kind:string,name:string,thumb:string}>} atts
   * @returns {string} HTML
   */
  function renderUserAttachments(atts) {
    if (!atts || !atts.length) return '';
    var html = '<div class="cv-user-atts">';
    for (var i = 0; i < atts.length; i++) {
      var a = atts[i] || {};
      var name = escapeHtml(String(a.name || '附件'));
      var thumb = String(a.thumb || '');
      if (a.kind === 'image') {
        if (thumb.indexOf('data:') === 0) {
          var src = escapeHtml(thumb);
          html += '<details class="cv-user-img"><summary>' +
            '<img class="cv-user-thumb" src="' + src + '" alt="" /></summary>' +
            '<img class="cv-user-img-full" src="' + src + '" alt="" /></details>';
        } else {
          html += '<span class="cv-user-file">🖼 ' + name + '</span>';
        }
      } else {
        html += '<span class="cv-user-file">📄 ' + name + '</span>';
      }
    }
    html += '</div>';
    return html;
  }

  /**
   * 清洗从网页提取的富文本 HTML：
   * 去脚本/表单/框架/外链跳转/事件属性，防止壳窗口被注入或误导航。
   */
  function sanitizeHtml(html) {
    try {
      var doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
      var kill = doc.querySelectorAll('script,iframe,object,embed,link,meta,style,form,input,button,select,textarea,video,audio,svg');
      for (var i = 0; i < kill.length; i++) kill[i].remove();
      var all = doc.body.querySelectorAll('*');
      for (var j = 0; j < all.length; j++) {
        var el = all[j];
        var attrs = Array.prototype.slice.call(el.attributes || []);
        for (var k = 0; k < attrs.length; k++) {
          var n = attrs[k].name.toLowerCase();
          var v = attrs[k].value || '';
          if (n.indexOf('on') === 0) { el.removeAttribute(attrs[k].name); continue; }
          if ((n === 'href' || n === 'src' || n === 'xlink:href') && /^\s*javascript:/i.test(v)) {
            el.removeAttribute(attrs[k].name); continue;
          }
          // 链接一律去 href（壳窗口不导航），只留文本样式
          if (n === 'href') el.removeAttribute(attrs[k].name);
          // 外部图片受 CSP 限制无法显示，去 src 避免破图
          if (n === 'src' && el.tagName === 'IMG' && v.indexOf('data:') !== 0) el.removeAttribute(attrs[k].name);
        }
      }
      return doc.body.innerHTML;
    } catch (_) {
      return escapeHtml(html);
    }
  }

  /**
   * 需求2：把 AI 回复 HTML 中的 <pre> 代码块默认折叠为 <details>（点击展开）。
   * 输入为 sanitizeHtml 后的安全 HTML 片段；用 DOMParser 解析后逐个 pre 包裹。
   */
  function foldAiCodeBlocks(html) {
    try {
      var doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
      var pres = doc.body.querySelectorAll('pre');
      for (var i = 0; i < pres.length; i++) {
        var pre = pres[i];
        var parent = pre.parentNode;
        if (!parent) continue;
        // 跳过已折叠的（避免重复包裹导致层级错乱）
        if (parent.tagName === 'DETAILS' && parent.classList && parent.classList.contains('cv-ai-code')) continue;
        var details = doc.createElement('details');
        details.className = 'cv-ai-code';
        var summary = doc.createElement('summary');
        summary.textContent = '▸ 展开代码';
        details.appendChild(summary);
        parent.insertBefore(details, pre);
        details.appendChild(pre);
      }
      return doc.body.innerHTML;
    } catch (_) {
      return html;
    }
  }

  /**
   * 渲染工具步骤区：
   *   - 执行中：转圈动画 + "代码正在运行中…"
   *   - 已完成：折叠为一行 "✓ 已完成 N 个工具步骤"
   */
  function renderSteps(msg, done) {
    var n = (msg.steps && msg.steps.length) || 0;
    if (!n) return '';
    if (done) {
      return '<div class="cv-steps-done"><span class="cv-steps-check">✓</span>已完成 ' + n + ' 个工具步骤</div>';
    }
    return '<div class="cv-steps-running"><span class="cv-steps-spinner"></span>代码正在运行中…</div>';
  }

  /** 渲染消息时间元素（始终显示/长显，位于消息内容上方） */
  function renderMsgTime(m) {
    if (!m || !m.time) return '';
    return '<div class="cv-msg-time">' + escapeHtml(formatClock(m.time)) + '</div>';
  }

  /** 渲染一条 AI 消息（图标 + 思考 + 步骤 + 叙述） */
  function renderAiMessage(msg, opts2) {
    var html = '';
    if (msg.thinking && msg.thinking.length) {
      for (var i = 0; i < msg.thinking.length; i++) {
        var th = msg.thinking[i];
        html += '<details class="cv-thinking"><summary>' +
          '<span class="cv-thinking-dot"></span>深度思考</summary>' +
          '<div class="cv-thinking-body">' + escapeHtml(th.text) + '</div></details>';
      }
    }
    html += renderSteps(msg, opts2.stepsDone);
    if (msg.html) {
      html += '<div class="cv-ai-body">' + foldAiCodeBlocks(sanitizeHtml(msg.html)) + '</div>';
    } else if (msg.text) {
      html += '<div class="cv-ai-body">' + escapeHtml(msg.text) + '</div>';
    }
    if (!html) return '';
    return '<div class="cv-msg cv-ai">' + renderMsgTime(msg) +
      '<div class="cv-ai-avatar" aria-hidden="true">' + AI_AVATAR_SVG + '</div>' +
      '<div class="cv-ai-inner">' + html + '</div></div>';
  }

  function render(data) {
    var wrap = els.messages;
    if (!wrap) return;
    var wasNearBottom = (wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight) < 80;
    var msgs = (data && data.messages) || [];

    var html = '';
    var lastAiIdx = -1;
    var i;
    for (i = 0; i < msgs.length; i++) {
      if (msgs[i].role === 'ai') lastAiIdx = i;
    }
    for (i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (m.role === 'user') {
        // 需求2：回执(receipt)也视为「用户发出」，与用户消息同样右侧气泡 + TF 头像，
        // 用 cv-user-receipt 类区分；回执折叠为 <details>，普通用户消息复用 renderUserText。
        if (m.kind === 'receipt') {
          html += '<div class="cv-msg cv-user cv-user-receipt">' + renderMsgTime(m) + '<div class="cv-user-avatar" aria-hidden="true">' + TF_USER_SVG + '</div><div class="cv-user-bubble">' + renderReceiptFold(m.text) + '</div></div>';
        } else {
          html += '<div class="cv-msg cv-user">' + renderMsgTime(m) + '<div class="cv-user-avatar" aria-hidden="true">' + TF_USER_SVG + '</div><div class="cv-user-bubble">' + renderUserText(m.text) + renderUserAttachments(m.attachments) + '</div></div>';
        }
        continue;
      }
      // AI 消息：步骤完成 = 其后存在回执，或全局已不在生成中
      var stepsDone = true;
      if (m.steps && m.steps.length) {
        stepsDone = !data.generating;
        if (!stepsDone) {
          for (var j = i + 1; j < msgs.length; j++) {
            if (msgs[j].role === 'user' && msgs[j].kind === 'receipt') { stepsDone = true; break; }
            if (msgs[j].role === 'ai') break; // 下一条 AI 已开口 → 本轮结束
          }
        }
      }
      html += renderAiMessage(m, { stepsDone: stepsDone, isLast: i === lastAiIdx });
    }

    if (data && data.generating) {
      html += '<div class="cv-typing"><span class="cv-typing-dot"></span><span class="cv-typing-dot"></span><span class="cv-typing-dot"></span> 生成中…</div>';
    }

    // 需求3：输入栏上方「AI 正在运行中」提示条。
    // runningFlag 来自 shell.js（AI 执行工具/代码期间也为真）；data.generating 覆盖生成文本期间。
    // 两者取或：任一为真都显示。
    lastGenerating = !!(data && data.generating);
    if (opts.onGenerating) opts.onGenerating(lastGenerating);
    var runBar = $('cv-running-bar');
    if (runBar) runBar.classList.toggle('cv-hidden', !(runningFlag || lastGenerating));

    var emptyEl = $('cv-empty');
    if (!msgs.length) {
      wrap.innerHTML = '';
      if (emptyEl) { wrap.appendChild(emptyEl); emptyEl.style.display = ''; }
    } else {
      wrap.innerHTML = html;
    }

    if (wasNearBottom) wrap.scrollTop = wrap.scrollHeight;
  }

  /**
   * 单条消息的「对齐签名」：只用角色/类型 + 正文前 60 字符，不含长度，
   * 这样流式追加（尾部增长）时同一消息的签名保持稳定，避免被当成新消息重复。
   */
  function alignSig(m) {
    if (!m) return '';
    var t = m.text || '';
    var h = m.html || '';
    var at = (m.attachments && m.attachments.length) || 0;
    return (m.role || '') + '|' + (m.kind || '') + '|' + at + '|' + t.slice(0, 60) + '|' + h.slice(0, 60);
  }

  /** 首次见到消息的时间记录（本地，DeepSeek DOM 无逐条时间戳） */
  function formatClock(ts) {
    var d = new Date(ts);
    var hh = d.getHours(), mm = d.getMinutes();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    var clock = pad(hh) + ':' + pad(mm);
    return sameDay ? clock : (pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + clock);
  }

  function firstSeenPrune() {
    if (firstSeenCount <= MAX_FIRSTSEEN) return;
    var keys = Object.keys(firstSeenMap);
    for (var i = 0; i < keys.length && firstSeenCount > MAX_FIRSTSEEN; i++) {
      delete firstSeenMap[keys[i]];
      firstSeenCount--;
    }
  }

  /**
   * 给「实时到达的新消息」打时间戳（修复：历史消息误显示查看时间）。
   * 判定原则：只有真正追加到会话尾部的新消息才打 Date.now()（即实时到达）；
   *   - 首屏基线（首次加载会话）：全部记 0（历史，不显示时间）；
   *   - 滚动加载的更早历史 / 切回时补载的消息：不在尾部新块 → 记 0；
   *   - 流式生成 / 实时轮询到达：构成尾部新块 → 打 Date.now()。
   * 实现：从数组末尾往前数连续的「未见过的签名」得到尾部新块起点 tailFrom；
   *   仅当 tailFrom 前面紧邻一条已知消息（即确属尾部追加，而非整体替换/全新数组）时，
   *   才给 [tailFrom, end) 打时间。
   * 时间写入消息对象本身（m.time），随 historyByKey 缓存保留。
   */
  function stampTimes(key, msgs) {
    if (!msgs || !msgs.length) return;
    var baselineDone = baselineKeys[key];
    // 预计算尾部连续新块起点（此时 firstSeenMap 尚未被本次修改）
    var tailFrom = msgs.length;
    for (var i = msgs.length - 1; i >= 0; i--) {
      var s = key + '\u0002' + alignSig(msgs[i]);
      if (Object.prototype.hasOwnProperty.call(firstSeenMap, s)) break;
      tailFrom = i;
    }
    // 仅当尾块前面紧邻一条已知消息时，视为真·尾部追加（实时到达）
    var hasTail = baselineDone && tailFrom > 0 && tailFrom < msgs.length;
    for (var j = 0; j < msgs.length; j++) {
      var m = msgs[j];
      if (!m) continue;
      var sig = key + '\u0002' + alignSig(m);
      if (Object.prototype.hasOwnProperty.call(firstSeenMap, sig)) {
        if (firstSeenMap[sig]) m.time = firstSeenMap[sig];
        else delete m.time;
        continue;
      }
      if (hasTail && j >= tailFrom) {
        firstSeenMap[sig] = Date.now();
        firstSeenCount++;
        m.time = firstSeenMap[sig];
      } else {
        firstSeenMap[sig] = 0;
        firstSeenCount++;
        delete m.time;
      }
    }
    if (!baselineDone) baselineKeys[key] = true;
    firstSeenPrune();
  }

  /**
   * 需求4：把新提取的消息合并进累积历史，兼容多种网页行为：
   *   - 虚拟滚动：新消息可能是历史的后缀、或与历史有部分重叠
   *   - 流式生成：最后一条 AI 消息内容增长 → 用新版本覆盖旧的同一条
   *   - 完整窗口：新消息 = 历史（或历史的前缀），不重复追加
   * 算法：在 acc 中找使 incoming 头部对齐最长的起点 p（k 最大，其次 p 最大＝更新）；
   *   合并 = acc[0..p) + incoming + acc[p+max(k,m) ..)（保留 acc 中 incoming 未覆盖的尾部）
   */
  function mergeMessages(acc, incoming) {
    if (!incoming || !incoming.length) return acc;
    if (!acc || !acc.length) return incoming.slice();
    var n = acc.length, m = incoming.length;
    var bestP = n, bestK = 0;
    for (var p = 0; p <= n; p++) {
      var k = 0;
      while (k < m && (p + k) < n && alignSig(acc[p + k]) === alignSig(incoming[k])) k++;
      if (k > bestK || (k === bestK && k > 0 && p > bestP)) { bestK = k; bestP = p; }
    }
    var merged = acc.slice(0, bestP).concat(incoming);
    var tailStart = bestP + Math.max(bestK, m);
    if (tailStart < n) merged = merged.concat(acc.slice(tailStart));
    if (merged.length > MAX_HISTORY) merged = merged.slice(merged.length - MAX_HISTORY);
    return merged;
  }

  /** 拉取并渲染（带签名去抖，内容没变不重绘） */
  function refresh(force) {
    if (!visible || refreshing || !opts.execInActive) return;
    refreshing = true;
    opts.execInActive('window.electronAPI && window.electronAPI.extractConversation ? window.electronAPI.extractConversation() : null')
      .then(function (r) {
        if (!r || !r.ok) return;
        var sig = r.messages.length + ':' + (r.generating ? 1 : 0) + ':' +
          r.messages.reduce(function (a, m) { return a + ((m.text || '').length + (m.html || '').length); }, 0);
        if (!force && sig === lastSig) return;
        lastSig = sig;

        // 需求3：缓存键 = profileId + sessionId；按 profile 记录最近会话键，切标签时可即时渲染
        var sid = r.sessionId || 'default';
        curSessionId = sid;
        var key = (activeProfileId || '') + '\u0001' + sid;
        if (!historyByKey[key]) historyByKey[key] = [];
        historyByKey[key] = mergeMessages(historyByKey[key], r.messages);
        lastKeyByProfile[activeProfileId || ''] = key;
        stampTimes(key, historyByKey[key]);

        render({ messages: historyByKey[key], generating: r.generating });
        if (opts.onSession && r.sessionId) opts.onSession(r.sessionId);
      })
      .catch(function () {})
      .then(function () { refreshing = false; });
  }

  /**
   * 需求3：切换当前 profile 缓存上下文（切标签时调用）。
   * 若该 profile 已有缓存消息，立即同步渲染（切换标签瞬间出内容），
   * 随后 applyViewModeForTab 触发的 refresh(true) 再在后台拉取最新内容覆盖。缓存不清空。
   */
  function setActiveProfile(pid) {
    pid = pid || '';
    if (pid === activeProfileId) return;
    activeProfileId = pid;
    lastSig = ''; // 上下文已变，下一次 refresh 必须重新渲染
    var key = lastKeyByProfile[pid];
    var wrap = els.messages;
    if (key && historyByKey[key] && historyByKey[key].length) {
      curSessionId = key.slice(key.indexOf('\u0001') + 1);
      render({ messages: historyByKey[key], generating: false });
    } else if (wrap) {
      // 该 profile 无缓存：先清空，避免显示上一个标签的残留内容
      wrap.innerHTML = '';
      curSessionId = '';
    }
  }

  function setVisible(v) {
    visible = !!v;
    var el = $('chat-view');
    if (el) el.classList.toggle('cv-hidden', !visible);
    if (visible) { reapplyProjectDir(); lastSig = ''; refresh(true); }
  }

  function isVisible() { return visible; }

  /** 缓存最后一次同步的项目目录 + 登录态，供视图重新显示时复评横幅 */
  var lastProjectDir = null;
  var needLogin = false;
  var pageReady = true;

  /**
   * 需求1：横幅互斥渲染（三态）。
   *   页面未就绪（加载中）→ 加载中横幅
   *   已就绪 + 未登录（登录页）→ 登录横幅
   *   已就绪 + 已登录 + 未初始化目录 → 初始化横幅
   *   已就绪 + 已登录 + 已初始化 → 都不显示
   */
  function applyBanners() {
    var loadingBanner = $('cv-loading-banner');
    var loginBanner = $('cv-login-banner');
    var initBanner = $('cv-init-banner');
    var hasDir = !!(lastProjectDir && lastProjectDir.trim() && lastProjectDir.trim() !== '未选择');
    if (loadingBanner) loadingBanner.classList.toggle('cv-hidden', pageReady);
    if (loginBanner) loginBanner.classList.toggle('cv-hidden', !pageReady || !needLogin);
    if (initBanner) initBanner.classList.toggle('cv-hidden', !pageReady || needLogin || hasDir);
  }

  /** 设置项目目录显示（空/未选择 → 显示初始化横幅） */
  function setProjectDir(dirText) {
    lastProjectDir = (dirText == null ? '' : String(dirText));
    applyBanners();
    // 项目目录变化时拉取文件列表（供 @ 补全）
    loadProjectFiles(lastProjectDir);
  }

  /**
   * 需求1：设置登录态（onLogin=true 表示当前处于登录页 / 未登录）。
   * 未登录时给 #chat-view 打 .cv-login-mode 标记（样式可弱化界面），并显示登录横幅。
   * @param {boolean} onLogin 是否需要登录（webview 内 quick-login 按钮可见 = true）
   */
  function setLoginState(onLogin) {
    needLogin = !!onLogin;
    var cv = $('chat-view');
    if (cv) cv.classList.toggle('cv-login-mode', needLogin && pageReady);
    applyBanners();
  }

  /**
   * 设置「页面是否已就绪」（webview 加载完成 = true）。
   * 未就绪时不显示初始化横幅（避免未登录/加载中误显示「初始化项目」）。
   * @param {boolean} on
   */
  function setPageReady(on) {
    var next = !!on;
    if (next === pageReady) return;
    pageReady = next;
    var cv = $('chat-view');
    if (cv) cv.classList.toggle('cv-login-mode', needLogin && pageReady);
    applyBanners();
  }

  /** 用缓存目录/登录态重新评估横幅（视图重新可见 / 刷新时调用，确保状态不过期） */
  function reapplyProjectDir() {
    applyBanners();
  }

  function setTitle(name) {
    var el = $('cv-title');
    if (el) el.textContent = name || '当前对话';
  }

  /**
   * 需求1：设置「AI 是否正在运行」（来自 shell.js 的 webview 状态同步）。
   * on=true → 显示输入栏上方提示条；false → 隐藏（但 render 时仍会 OR 上 data.generating）。
   * @param {boolean} on
   */
  function setRunning(on) {
    runningFlag = !!on;
    var runBar = $('cv-running-bar');
    if (runBar) runBar.classList.toggle('cv-hidden', !(runningFlag || lastGenerating));
  }

  // ===== @ 引用文件（上下文选择器） =====
  var projectFiles = [];      // 当前项目文件列表（相对路径）
  var filesForDir = '';       // projectFiles 对应的项目目录
  var atState = { open: false, start: -1, query: '', items: [], active: 0 };

  /** 拉取当前项目文件列表（异步，失败静默，不影响主流程） */
  function loadProjectFiles(dir) {
    var d = (dir == null ? '' : String(dir)).trim();
    if (!d || d === '未选择' || d === filesForDir) return;
    if (!window.shellAPI || typeof window.shellAPI.listProjectFiles !== 'function') return;
    window.shellAPI.listProjectFiles(d).then(function (res) {
      if (res && res.success && Array.isArray(res.files)) {
        projectFiles = res.files;
        filesForDir = d;
      }
    }).catch(function () {});
  }

  function atMenuEl() { return $('cv-at-menu'); }

  function closeAtMenu() {
    atState.open = false;
    atState.start = -1;
    atState.query = '';
    atState.items = [];
    atState.active = 0;
    var m = atMenuEl();
    if (m) { m.classList.add('cv-hidden'); m.innerHTML = ''; }
  }

  /** 计算当前光标前是否处于 @ 触发语境；返回 {start, query} 或 null */
  function detectAtTrigger(input) {
    var pos = input.selectionStart;
    if (pos == null) return null;
    var before = input.value.slice(0, pos);
    // @ 到光标间不允许空白/换行（@path 不含空格）
    var at = before.lastIndexOf('@');
    if (at === -1) return null;
    var seg = before.slice(at + 1);
    if (/[\s]/.test(seg)) return null;
    // @ 前必须是行首或空白（避免 email 之类误触发）
    var prev = at > 0 ? before.charAt(at - 1) : '';
    if (prev && !/\s/.test(prev)) return null;
    return { start: at, query: seg };
  }

  function renderAtMenu() {
    var m = atMenuEl();
    if (!m) return;
    if (!atState.items.length) {
      m.innerHTML = '<div class="cv-at-empty">' +
        (projectFiles.length ? '无匹配文件' : '正在加载项目文件…') + '</div>';
      m.classList.remove('cv-hidden');
      return;
    }
    var html = '';
    for (var i = 0; i < atState.items.length; i++) {
      var p = atState.items[i];
      html += '<div class="cv-at-item' + (i === atState.active ? ' active' : '') +
        '" data-idx="' + i + '"><span class="cv-at-path">' + escapeHtml(p) + '</span></div>';
    }
    m.innerHTML = html;
    m.classList.remove('cv-hidden');
    var activeEl = m.querySelector('.cv-at-item.active');
    if (activeEl && activeEl.scrollIntoView) activeEl.scrollIntoView({ block: 'nearest' });
  }

  function refreshAtMenu(input) {
    var trig = detectAtTrigger(input);
    if (!trig) { closeAtMenu(); return; }
    var q = trig.query.toLowerCase();
    var matches = [];
    for (var i = 0; i < projectFiles.length && matches.length < 50; i++) {
      if (!q || projectFiles[i].toLowerCase().indexOf(q) !== -1) matches.push(projectFiles[i]);
    }
    atState.open = true;
    atState.start = trig.start;
    atState.query = trig.query;
    atState.items = matches;
    atState.active = 0;
    renderAtMenu();
  }

  /** 用 @path 替换输入框中的 @query 段 */
  function applyAtSelection(input, filePath) {
    var val = input.value;
    var pos = input.selectionStart != null ? input.selectionStart : val.length;
    var start = atState.start >= 0 ? atState.start : pos;
    var end = pos;
    var insert = '@' + filePath + ' ';
    input.value = val.slice(0, start) + insert + val.slice(end);
    var caret = start + insert.length;
    try { input.setSelectionRange(caret, caret); } catch (_) {}
    closeAtMenu();
    input.focus();
  }

  // ===== AI 消息图片：点击放大（lightbox）+ 保存到本地 =====
  var lightboxEl = null;
  var lightboxImg = null;

  /** 懒创建单例放大层（幂等），返回容器元素 */
  function ensureLightbox() {
    if (lightboxEl && lightboxEl.parentNode) return lightboxEl;
    var box = document.createElement('div');
    box.id = 'cv-img-lightbox';
    box.className = 'cv-hidden';
    var img = document.createElement('img');
    img.alt = '';
    var saveBtn = document.createElement('button');
    saveBtn.id = 'cv-img-lightbox-save';
    saveBtn.type = 'button';
    saveBtn.textContent = '保存到本地';
    box.appendChild(img);
    box.appendChild(saveBtn);
    (document.body || document.documentElement).appendChild(box);

    // 点遮罩空白处关闭（点图片本身不关闭）
    box.addEventListener('click', function (e) { if (e.target === box) closeLightbox(); });
    // 保存按钮：把当前图片写到本地
    saveBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var src = img.getAttribute('src') || '';
      if (src) saveImageSrc(src, saveBtn);
    });

    lightboxEl = box;
    lightboxImg = img;
    return box;
  }

  /** 从 src 推断一个合理的默认文件名 */
  function defaultImageName(src) {
    var ext = 'png';
    var m = /^data:image\/([a-z0-9.+-]+)/i.exec(String(src || ''));
    if (m) ext = m[1].toLowerCase().replace('jpeg', 'jpg');
    return 'tokfree-image-' + Date.now() + '.' + ext;
  }

  /** 保存图片：dataURL 直接传；http(s) 传 url 由主进程下载；blob 先转 dataURL */
  function saveImageSrc(src, btn) {
    if (!window.shellAPI || typeof window.shellAPI.saveImage !== 'function') return;
    var old = btn.textContent;
    function done(ok) {
      btn.textContent = ok ? '已保存' : '保存失败';
      setTimeout(function () { btn.textContent = old; btn.disabled = false; }, 1600);
    }
    function doSave(payload) {
      btn.disabled = true;
      btn.textContent = '保存中…';
      window.shellAPI.saveImage(payload).then(function (res) {
        done(!!(res && res.success));
      }).catch(function () { done(false); });
    }
    if (src.indexOf('data:') === 0) {
      doSave({ dataUrl: src, defaultName: defaultImageName(src) });
    } else if (/^https?:/i.test(src)) {
      doSave({ url: src, defaultName: defaultImageName(src) });
    } else if (src.indexOf('blob:') === 0) {
      // blob: 只能在渲染层读取，先转 dataURL 再交给主进程写盘
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', src, true);
        xhr.responseType = 'blob';
        xhr.onload = function () {
          var fr = new FileReader();
          fr.onload = function () { doSave({ dataUrl: String(fr.result || ''), defaultName: defaultImageName(src) }); };
          fr.readAsDataURL(xhr.response);
        };
        xhr.onerror = function () { done(false); };
        xhr.send();
      } catch (_) { done(false); }
    }
  }

  function openLightbox(src) {
    var box = ensureLightbox();
    lightboxImg.setAttribute('src', src);
    box.classList.remove('cv-hidden');
  }

  function closeLightbox() {
    if (lightboxEl) lightboxEl.classList.add('cv-hidden');
    if (lightboxImg) lightboxImg.removeAttribute('src');
  }

  function onLightboxKey(e) {
    if (e && (e.key === 'Escape' || e.keyCode === 27)) closeLightbox();
  }

  function bindEvents() {
    var sendBtn = $('cv-send');
    var input = $('cv-input');
    function doSend() {
      if (!input || !opts.sendText) return;
      var raw = input.value;
      if (!raw.trim()) return;
      var text = expandRefsForSend(raw).trim();
      if (!text) return;
      closeAtMenu();
      opts.sendText(text).then(function (ok) {
        if (ok) { input.value = ''; setTimeout(function () { refresh(true); }, 800); }
      });
    }
    // 把输入框里的 @相对路径 展开为 AI 可读的引用标记【引用：绝对路径】。
    // 只展开确实命中项目文件列表的 token，避免误伤普通 @ 文本。
    function expandRefsForSend(raw) {
      if (!raw || raw.indexOf('@') === -1 || !projectFiles.length) return raw;
      var known = {};
      for (var k = 0; k < projectFiles.length; k++) known[projectFiles[k]] = true;
      var dir = (lastProjectDir && lastProjectDir !== '未选择') ? lastProjectDir.replace(/[\\/]+$/, '') : '';
      return raw.replace(/@([^\s@]+)/g, function (whole, rel) {
        if (!known[rel]) return whole;
        var abs = dir ? (dir + '/' + rel) : rel;
        return '【引用：' + abs + '】';
      });
    }

    if (sendBtn) sendBtn.addEventListener('click', doSend);
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.isComposing || e.keyCode === 229) return;
        if (atState.open) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (atState.items.length) atState.active = (atState.active + 1) % atState.items.length;
            renderAtMenu();
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (atState.items.length) atState.active = (atState.active - 1 + atState.items.length) % atState.items.length;
            renderAtMenu();
            return;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            if (atState.items.length) {
              e.preventDefault();
              applyAtSelection(input, atState.items[atState.active]);
              return;
            }
          }
          if (e.key === 'Escape') { e.preventDefault(); closeAtMenu(); return; }
        }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
      });
      input.addEventListener('input', function () { refreshAtMenu(input); });
      input.addEventListener('click', function () { refreshAtMenu(input); });
      // 失焦时关闭菜单（点菜单项用 mousedown 拦截，先于 blur 生效）
      input.addEventListener('blur', function () { closeAtMenu(); });
    }
    // @ 菜单项点击（mousedown 先于 blur，避免点选时输入框失焦导致菜单消失）
    var atMenu = atMenuEl();
    if (atMenu && input) {
      atMenu.addEventListener('mousedown', function (e) {
        var item = e.target && e.target.closest ? e.target.closest('.cv-at-item') : null;
        if (!item) return;
        e.preventDefault();
        var idx = parseInt(item.getAttribute('data-idx'), 10);
        if (!isNaN(idx) && atState.items[idx]) applyAtSelection(input, atState.items[idx]);
      });
    }
    var newBtn = $('cv-btn-new');
    if (newBtn && opts.onNewChat) newBtn.addEventListener('click', function () { opts.onNewChat(); });
    var initBtn = $('cv-btn-init');
    if (initBtn && opts.onInitProject) initBtn.addEventListener('click', function () { opts.onInitProject(); });
    // 需求1：登录横幅「去登录」→ 切到网页视图让用户登录/输验证码
    var goLoginBtn = $('cv-btn-gologin');
    if (goLoginBtn) goLoginBtn.addEventListener('click', function () {
      if (opts.onGoLogin) opts.onGoLogin();
    });
    // AI 消息图片：事件委托（在消息容器上绑一次，容器 innerHTML 重写不丢绑），点击放大
    if (els.messages) {
      els.messages.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || t.tagName !== 'IMG') return;
        if (!t.closest || !t.closest('.cv-ai-body')) return;
        var src = t.getAttribute('src') || '';
        if (!src) return;
        e.preventDefault();
        openLightbox(src);
      });
    }
    // Esc 关闭放大层（document 级，绑一次）
    document.addEventListener('keydown', onLightboxKey);
  }

  /**
   * @param {object} o
   *   execInActive(code) → Promise   在活动 webview 里执行 JS
   *   sendText(text) → Promise<bool> 发送用户消息（走网页内排队机制）
   *   onNewChat()                    开启新对话
   *   onInitProject()                点击「初始化项目」
   *   onSession(sessionId)           提取到当前会话 ID 时回调
   */
  function init(o) {
    opts = o || {};
    injectStyle();
    els.messages = $('cv-messages');
    els.empty = $('cv-empty');
    bindEvents();
  }

  return {
    init: init,
    refresh: refresh,
    setVisible: setVisible,
    isVisible: isVisible,
    setActiveProfile: setActiveProfile,
    setProjectDir: setProjectDir,
    setLoginState: setLoginState,
    setPageReady: setPageReady,
    setTitle: setTitle,
    setRunning: setRunning,
    isGenerating: function () { return !!lastGenerating; },
    injectStyle: injectStyle,
  };
})();
