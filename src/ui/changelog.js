/*
 * 更新日志弹窗渲染逻辑
 * 数据来自主进程 IPC 'get-changelog'（解析后的 CHANGELOG 数组）。
 * Markdown 用简单正则渲染（不引库）：### 小节标题 / 列表 / 加粗 / 行内代码。
 */
(function () {
  'use strict';

  var tabsEl = document.getElementById('cl-tabs');
  var contentEl = document.getElementById('cl-content');
  var closeBtn = document.getElementById('cl-close');

  var versions = [];
  var activeIndex = 0;

  /** 转义 HTML，避免 CHANGELOG 内容破坏页面 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var CODE = String.fromCharCode(96); // 反引号（避免在源码里出现转义困扰）
  var INLINE_CODE_RE = new RegExp(CODE + '([^' + CODE + ']+)' + CODE, 'g');

  /** 行内 Markdown：加粗 + 行内代码 */
  function inline(s) {
    var out = esc(s);
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(INLINE_CODE_RE, '<code>$1</code>');
    return out;
  }

  /** 块级 Markdown 简渲染：### 小节 / - 列表 / 普通段落 */
  function renderBody(md) {
    var lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    var html = '';
    var inList = false;
    function closeList() { if (inList) { html += '</ul>'; inList = false; } }
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t) { closeList(); continue; }
      var h3 = t.match(/^###\s+(.*)$/);
      if (h3) { closeList(); html += '<h3>' + inline(h3[1]) + '</h3>'; continue; }
      var h2 = t.match(/^##\s+(.*)$/);
      if (h2) { closeList(); html += '<h3>' + inline(h2[1]) + '</h3>'; continue; }
      var li = t.match(/^[-*]\s+(.*)$/);
      if (li) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += '<li>' + inline(li[1]) + '</li>';
        continue;
      }
      closeList();
      html += '<p>' + inline(t) + '</p>';
    }
    closeList();
    return html;
  }

  /** 渲染标签栏；最新版（index 0）默认 active 并带小绿点 */
  function renderTabs() {
    if (!tabsEl) return;
    var frag = document.createDocumentFragment();
    versions.forEach(function (v, i) {
      var btn = document.createElement('button');
      btn.className = 'cl-tab' + (i === activeIndex ? ' active' : '');
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
      btn.textContent = v.version;
      if (i === 0) {
        var dot = document.createElement('span');
        dot.className = 'cl-latest-dot';
        dot.title = '最新版本';
        btn.appendChild(dot);
      }
      btn.addEventListener('click', function () { selectVersion(i); });
      frag.appendChild(btn);
    });
    tabsEl.innerHTML = '';
    tabsEl.appendChild(frag);
  }

  /** 渲染当前版本内容 */
  function renderContent() {
    if (!contentEl) return;
    var v = versions[activeIndex];
    if (!v) { contentEl.innerHTML = '<div class="cl-empty">暂无更新日志</div>'; return; }
    var head = '<div class="cl-version-head">'
      + '<span class="cl-version-num">' + esc(v.version) + '</span>'
      + (v.date ? '<span class="cl-version-date">' + esc(v.date) + '</span>' : '')
      + '</div>';
    contentEl.innerHTML = '<div class="cl-version-card">' + head
      + '<div class="cl-body">' + renderBody(v.body) + '</div></div>';
    contentEl.scrollTop = 0;
  }

  function selectVersion(i) {
    if (i < 0 || i >= versions.length) return;
    activeIndex = i;
    renderTabs();
    renderContent();
  }

  function boot(data) {
    versions = (data && data.versions) || [];
    activeIndex = 0; // 最新版本默认展示（解析结果按新→旧排列）
    if (!versions.length) {
      if (tabsEl) tabsEl.innerHTML = '';
      if (contentEl) {
        var msg = (data && data.error) ? ('读取更新日志失败：' + data.error) : '暂无更新日志';
        contentEl.innerHTML = '<div class="cl-empty">' + esc(msg) + '</div>';
      }
      return;
    }
    renderTabs();
    renderContent();
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', function () { try { window.close(); } catch (_) {} });
  }

  try {
    if (window.changelogAPI && typeof window.changelogAPI.getChangelog === 'function') {
      window.changelogAPI.getChangelog().then(boot).catch(function (err) {
        boot({ success: false, error: (err && err.message) || String(err), versions: [] });
      });
    } else {
      boot({ success: false, error: 'changelogAPI 不可用', versions: [] });
    }
  } catch (err) {
    boot({ success: false, error: (err && err.message) || String(err), versions: [] });
  }
})();
