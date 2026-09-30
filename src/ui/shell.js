/**
 * TokFree 壳层标签管理（v2）
 * - 每个标签 = 一个 <webview>，partition 独立（persist:<profileId>），profileId 与主进程注册一一对应
 * - 支持 新建 / 切换 / 关闭 / 主进程命令打开或替换标签
 * - 左侧栏：当前标签的 AI 会话列表（绑定会话 ID，点击跳转）+ 账户区
 * - 主题：浅色默认 / 暗色切换（localStorage 持久化）
 */
(function () {
  'use strict';

  var DEFAULT_URL = 'https://chat.deepseek.com/';
  var WEBVIEW_PRELOAD = (window.shellAPI && window.shellAPI.webviewPreload) || '';
  // 标签持久化键：重启后据此恢复上次打开的标签
  var TAB_PERSIST_KEY = 'tokfree-open-tabs';

  var tabListEl = document.getElementById('tab-list');
  var containerEl = document.getElementById('webview-container');
  var newTabBtn = document.getElementById('new-tab-btn');

  var tabs = [];            // { id, profileId, partition, title, url, name }
  var webviews = new Map(); // id -> webview element
  var activeId = null;
  var seq = 0;
  var curSessionId = null;  // 当前活动会话 ID（左侧列表高亮用）
  // 标签状态标识（与「窗口管理」同一数据源 list-windows-status）
  // 必须在此处（模块级变量区）声明：restoreTabs→createTab→renderTabs→tabStatusClass
  // 会在初始化早期读取它，若声明在文件后部会因 var 提升为 undefined 而抛 TypeError。
  var tabStatusMap = {};      // profileId → state
  var tabRoleMap = {};        // profileId → role ('master'|'worker'|'')
  var profileProviderMap = {}; // profileId → providerId（判断标签是否 API 型平台）
  var providerHomeUrlMap = {}; // providerId → homeUrl（新建对话时跳对应平台首页）
  var tabStatusInFlight = false;

  // webview preload 需要 Node（原 preload 大量 require），
  // 显式声明 contextIsolation=yes, sandbox=no，保证隔离上下文同时保留 Node 能力。
  var WEBVIEW_WEBPREFS = 'contextIsolation=yes,sandbox=no';

  // ===== 主题（单一真源：主进程 settings.theme，经 shellAPI 同步） =====
  var currentTheme = 'light';

  function applyTheme(theme) {
    currentTheme = (theme === 'dark') ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', currentTheme);
  }

  function getTheme() {
    if (window.shellAPI && window.shellAPI.getTheme) {
      return window.shellAPI.getTheme();
    }
    return Promise.resolve(currentTheme);
  }

  function toggleTheme() {
    var next = currentTheme === 'dark' ? 'light' : 'dark';
    if (window.shellAPI && window.shellAPI.setTheme) {
      try { window.shellAPI.setTheme(next); } catch (_) {}
    } else {
      applyTheme(next);
    }
  }

  // 初始化：从主进程读取主题；并订阅广播，统一由广播驱动应用
  applyTheme('light');
  getTheme().then(function (t) { applyTheme(t); }).catch(function () {});
  if (window.shellAPI && window.shellAPI.onThemeChanged) {
    window.shellAPI.onThemeChanged(function (t) { applyTheme(t); });
  }

  // 跨窗口同步：任何窗口重命名会话后，主进程广播 'session-renamed'；
  // 本壳层刷新会话列表以显示新别名（网页端标题改名由各 webview preload 各自处理）。
  if (window.shellAPI && window.shellAPI.onSessionRenamed) {
    window.shellAPI.onSessionRenamed(function () { syncSessionList(); });
  }

  // ===== 标签基础 =====
  function nextId() {
    seq += 1;
    return 'tab-' + Date.now() + '-' + seq;
  }

  function findTab(id) {
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].id === id) return tabs[i];
    }
    return null;
  }

  function findTabByProfile(profileId) {
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].profileId === profileId) return tabs[i];
    }
    return null;
  }

  // ===== 标签持久化（重启恢复上次打开的标签） =====
  var restoringTabs = false;
  // ===== 启动加载遮罩：恢复标签期间显示进度并禁止操作，全部完成/失败处理后消失 =====
  var bootMask = {
    el: null,
    statusEl: null,
    barEl: null,
    errorsEl: null,
    actionsEl: null,
    retryBtn: null,
    continueBtn: null,
    total: 0,
    done: 0,
    failed: [],        // { id, name, reason }
    active: false,
    onRetry: null,
    timer: null
  };
  var BOOT_TIMEOUT_MS = 30000;

  function bootInit() {
    bootMask.el = document.getElementById('boot-mask');
    bootMask.statusEl = document.getElementById('boot-status');
    bootMask.barEl = document.getElementById('boot-bar-fill');
    bootMask.errorsEl = document.getElementById('boot-errors');
    bootMask.actionsEl = document.getElementById('boot-actions');
    bootMask.retryBtn = document.getElementById('boot-btn-retry');
    bootMask.continueBtn = document.getElementById('boot-btn-continue');
    if (bootMask.retryBtn) bootMask.retryBtn.addEventListener('click', function () {
      // 重试：仅重新加载失败的标签（不重建全部标签，避免重复）。
      var list = bootMask.failed.slice();
      var retryable = [];
      for (var i = 0; i < list.length; i++) { if (list[i].id) retryable.push(list[i]); }
      if (!retryable.length) {
        // 无对应标签 id（兜底）：交给外部回调（如重跑 restoreTabs）
        var fn = bootMask.onRetry;
        bootFinish();
        if (typeof fn === 'function') fn();
        return;
      }
      bootStart(retryable.length, bootMask.onRetry);
      retryable.forEach(function (it) {
        var t = findTab(it.id);
        var wv = webviews.get(it.id);
        if (t) { t.bootTracked = true; t.bootSettled = false; }
        if (!wv) { bootAdvance(it.name, false, it.reason); return; }
        bootArmTimeout(it.id, it.name);
        try {
          var target = (t && t.url) || DEFAULT_URL;
          if (!wv.getAttribute('src')) wv.setAttribute('src', target);
          else wv.loadURL(target);
        } catch (_) { bootAdvance(it.name, false, it.reason); }
      });
    });
    if (bootMask.continueBtn) bootMask.continueBtn.addEventListener('click', function () {
      bootFinish();
    });
  }

  // 开始启动进度（total = 需要立即加载的标签数）
  function bootStart(total, onRetry) {
    if (!bootMask.el) return;
    bootMask.total = total;
    bootMask.done = 0;
    bootMask.failed = [];
    bootMask.active = true;
    bootMask.onRetry = onRetry || null;
    bootMask.el.classList.remove('boot-hidden');
    if (bootMask.errorsEl) { bootMask.errorsEl.classList.add('boot-hidden'); bootMask.errorsEl.innerHTML = ''; }
    if (bootMask.actionsEl) bootMask.actionsEl.classList.add('boot-hidden');
    bootRender();
    if (bootMask.timer) clearTimeout(bootMask.timer);
  }

  // 某个标签加载完成（成功或失败）
  function bootAdvance(name, ok, reason, tabId) {
    if (!bootMask.active) return;
    bootMask.done += 1;
    if (!ok) bootMask.failed.push({ id: tabId || '', name: name || '标签', reason: reason || '加载失败' });
    bootRender();
    if (bootMask.done >= bootMask.total) {
      if (bootMask.failed.length) bootShowErrors();
      else bootFinish();
    }
  }

  function bootRender() {
    if (!bootMask.statusEl) return;
    var total = bootMask.total;
    var done = Math.min(bootMask.done, total);
    bootMask.statusEl.textContent = '正在加载 ' + done + '/' + total + ' 个标签';
    var pct = total > 0 ? Math.round((done / total) * 100) : 100;
    if (bootMask.barEl) bootMask.barEl.style.width = pct + '%';
  }

  // 有失败：显示失败列表 + 继续/重试按钮，遮罩保持（用户可读错误）
  function bootShowErrors() {
    if (bootMask.statusEl) bootMask.statusEl.textContent = '有 ' + bootMask.failed.length + ' 个标签加载失败';
    if (bootMask.barEl) bootMask.barEl.style.width = '100%';
    if (bootMask.errorsEl) {
      var html = '';
      for (var i = 0; i < bootMask.failed.length; i++) {
        html += '<div class="boot-err-item">✕ ' + escapeHtml(bootMask.failed[i].name) + '：' + escapeHtml(bootMask.failed[i].reason) + '</div>';
      }
      bootMask.errorsEl.innerHTML = html;
      bootMask.errorsEl.classList.remove('boot-hidden');
    }
    if (bootMask.actionsEl) bootMask.actionsEl.classList.remove('boot-hidden');
  }

  function bootFinish() {
    bootMask.active = false;
    if (bootMask.timer) { clearTimeout(bootMask.timer); bootMask.timer = null; }
    if (bootMask.el) bootMask.el.classList.add('boot-hidden');
  }

  // 设置单个标签的超时兜底（返回一个 markDone 回调）
  function bootArmTimeout(tabId, name) {
    if (!bootMask.active) return;
    setTimeout(function () {
      var t = findTab(tabId);
      if (t && t.bootSettled) return;
      if (t) t.bootSettled = true;
      bootAdvance(name || (t && t.title) || '标签', false, '加载超时（30s）', tabId);
    }, BOOT_TIMEOUT_MS);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var lastPersistCount = null; // 上次持久化的标签数量（用于检测数量突变）

  function persistTabs() {
    if (restoringTabs) return;
    try {
      var list = tabs.map(function (t) {
        return { profileId: t.profileId, partition: t.partition, name: t.title, url: t.url, viewMode: t.viewMode || 'agent' };
      });
      var active = activeId ? findTab(activeId) : null;
      localStorage.setItem(TAB_PERSIST_KEY, JSON.stringify({
        tabs: list,
        activeProfileId: active ? active.profileId : ''
      }));
      // 数量突变诊断：本次比上次少且非用户关闭标签时告警（不影响写入行为）
      if (typeof lastPersistCount === 'number' && list.length < lastPersistCount) {
        console.warn('[shell] 标签持久化数量减少: ' + lastPersistCount + ' -> ' + list.length + '（若非用户关闭标签请排查）');
      }
      lastPersistCount = list.length;
    } catch (_) {}
  }

  // 关闭应用前再持久化一次（幂等：persistTabs 内部对 restoringTabs 有保护，且无副作用）。
  window.addEventListener('beforeunload', function () { persistTabs(); });

  // 启动时恢复：有持久化数据则并行重建标签并激活上次活动标签；否则退回默认单标签。
  // 加速要点：
  //  1) 并行创建（createTab 内含主进程 createTabProfile 往返）而非串行 await；
  //  2) 非 active 标签懒加载：先建 DOM 不 loadURL，切到该标签时再首次加载；
  //  3) 只让上次 active 的那个标签立即加载（避免恢复时同时拉 N 个 DeepSeek 重页面）。
  async function restoreTabs() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(TAB_PERSIST_KEY) || 'null'); } catch (_) {}
    if (!saved || !Array.isArray(saved.tabs) || saved.tabs.length === 0) {
      await bootCreateDefault();
      return;
    }
    restoringTabs = true;
    // 用 try/finally 保证：无论恢复过程是否抛异常，restoringTabs 最终必被复位为 false，
    // 否则 persistTabs() 会被永久挡住，导致之后新建的标签永不写入 localStorage。
    try {
      // 防僵尸记录：先拿一次当前存在的 profile 集合，循环里同步校验（跳过已删除的 profile）
      var aliveProfiles = null;
      try {
        if (window.shellAPI && window.shellAPI.listProfiles) {
          var pr = await window.shellAPI.listProfiles();
          if (pr && pr.success && Array.isArray(pr.profiles)) {
            aliveProfiles = {};
            pr.profiles.forEach(function (p) { if (p && p.id) aliveProfiles[p.id] = true; });
          }
        }
      } catch (_) { aliveProfiles = null; }
      var activeProfile = saved.activeProfileId || '';
      // 找到恢复后应激活的标签下标（无匹配则第一个）
      var activeIdx = 0;
      var valid = [];
      for (var i = 0; i < saved.tabs.length; i++) {
        var s = saved.tabs[i];
        if (!s) continue;                    // 仅跳过完全空条目
        if (!s.partition) {
          // partition 缺失：用 profileId 推导 fallback（persist:<profileId>），仍尝试恢复，避免丢失
          if (s.profileId) s.partition = 'persist:' + s.profileId;
          else continue;                     // profileId 也没有才跳过（无法恢复）
        }
        // 防僵尸记录：该 profile 已被删除（不在主进程列表中）则跳过，避免恢复出空壳标签
        if (s.profileId && aliveProfiles && !aliveProfiles[s.profileId]) {
          console.warn('[shell] 跳过已失效 profile 的标签恢复:', s.profileId);
          continue;
        }
        if (activeProfile && s.profileId && s.profileId === activeProfile) activeIdx = valid.length;
        valid.push(s);
      }
      if (!valid.length) { await bootCreateDefault(); return; }

      // 恢复时「全部标签都立即加载」——因为要等全部完成才开放操作，首屏只显示一次进度。
      // 放弃懒加载加速（懒加载标签切到才加载，无法计入启动进度，会导致遮罩提前消失）。
      bootStart(valid.length, function () { restoreTabs(); });
      var created = await Promise.all(valid.map(function (s) {
        // 单个 createTab 失败（如 profileId 失效）不应阻断其它标签恢复：捕获后返回 null。
        return createTab({
          profileId: s.profileId || '',
          partition: s.partition,
          url: s.url || DEFAULT_URL,
          name: s.name || '',
          viewMode: (s.viewMode === 'web' || s.viewMode === 'agent') ? s.viewMode : 'agent',
          lazy: false,
          bootTracked: true,
          activate: false
        }).catch(function (e) {
          console.warn('[shell] 恢复标签失败:', e && e.message);
          return null;
        });
      }));
      if (!tabs.length) { await bootCreateDefault(); return; }
      // created[activeIdx] 可能为 null（该标签恢复失败），回退到第一个可用标签。
      var activeTabId = created[activeIdx] || (tabs[0] && tabs[0].id);
      if (activeTabId) switchTab(activeTabId);
    } finally {
      restoringTabs = false;
    }
    // 恢复结束后把当前真实标签列表写回，修复历史上被 restoringTabs 挡住而未持久化的数据。
    persistTabs();
  }

  // 默认单标签启动（无持久化数据时）：也纳入启动进度。
  async function bootCreateDefault() {
    bootStart(1, null);
    await createTab({ lazy: false, bootTracked: true });
  }

  /**
   * 创建标签。
   * @param {object} [opts] { profileId, partition, url, name }
   *   缺省 → 向主进程申请新 profile（partition = persist:<profileId>）。
   * @returns {Promise<string>} 标签 id
   */
  async function createTab(opts) {
    opts = opts || {};
    var id = nextId();
    var profileId = opts.profileId || '';
    var partition = opts.partition || '';
    var url = opts.url || DEFAULT_URL;
    var name = opts.name || '';
    var userAgent = opts.userAgent || '';
    // 懒加载：非活动标签先不真正 loadURL，切到该标签时再首次加载（启动/恢复加速）
    var lazy = !!opts.lazy;
    var viewMode = (opts.viewMode === 'web' || opts.viewMode === 'agent') ? opts.viewMode : 'agent';

    if (!profileId || !partition) {
      // 主进程侧创建 profile：partition 固定为 'persist:<profileId>'，
      // did-attach-webview 据 session 存储路径末段反查同一 profile 并注册进 windowState。
      partition = partition || ('persist:' + id);
      try {
        if (window.shellAPI && window.shellAPI.createTabProfile) {
          var res = await window.shellAPI.createTabProfile(name);
          if (res && res.success && res.partition) {
            partition = res.partition;
            profileId = res.profileId || profileId;
            if (res.userAgent) userAgent = res.userAgent;
          } else {
            console.warn('[shell] createTabProfile 失败，回退本地 partition:', res && res.error);
          }
        }
      } catch (e) {
        console.warn('[shell] createTabProfile 异常，回退本地 partition:', e && e.message);
      }
    }

    var wv = document.createElement('webview');
    // 懒加载标签：延迟到首次切到该标签再 loadURL（src 留空，避免后台标签抢带宽）。
    // bootTracked：是否计入启动进度（恢复时所有标签都加载并计入；新建标签不计入）。
    var bootTracked = !!opts.bootTracked;
    // 反检测（关键顺序）：useragent / partition / preload 必须在设置 src 之前同步设好，
    // 否则 webview 首个请求可能带着默认 Electron UA 发出，泄漏自动化特征。
    if (userAgent) wv.setAttribute('useragent', userAgent);
    wv.setAttribute('partition', partition);
    if (WEBVIEW_PRELOAD) wv.setAttribute('preload', WEBVIEW_PRELOAD);
    if (!lazy) wv.setAttribute('src', url);
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('webpreferences', WEBVIEW_WEBPREFS);
    wv.dataset.tabId = id;
    wv.style.display = 'none';

    wv.addEventListener('page-title-updated', function (e) {
      var t = findTab(id);
      if (t && e && e.title) { t.title = e.title; renderTabs(); }
    });
    wv.addEventListener('did-navigate', function (e) {
      var t = findTab(id);
      if (t && e) { t.url = e.url; renderTabs(); }
      // 主框架导航开始：该标签页面进入未就绪状态（直到 did-finish-load）
      if (t) t.pageReady = false;
      if (id === activeId) syncPageReady();
    });
    wv.addEventListener('did-navigate-in-page', function (e) {
      var t = findTab(id);
      if (t && e) { t.url = e.url; renderTabs(); }
    });
    // 启动遮罩进度：did-finish-load = 成功；did-fail-load = 失败（主框架）。
    wv.addEventListener('did-finish-load', function () {
      var t = findTab(id);
      if (t) t.pageReady = true;
      if (id === activeId) syncPageReady();
      if (t && t.bootTracked && !t.bootSettled) {
        t.bootSettled = true;
        bootAdvance(t.title, true, '', id);
      }
    });
    wv.addEventListener('did-fail-load', function (e) {
      // 只统计主框架失败（isMainFrame 为 false 的子资源失败忽略）
      if (e && e.isMainFrame === false) return;
      if (e && e.errorCode === -3) return; // ERR_ABORTED：导航被打断（如重定向），不算失败
      var t = findTab(id);
      if (t && t.bootTracked && !t.bootSettled) {
        t.bootSettled = true;
        var desc = (e && (e.errorDescription || e.errorCode)) || '未知错误';
        bootAdvance(t.title, false, desc + (e && e.errorCode ? ' (' + e.errorCode + ')' : ''), id);
      }
    });
    wv.addEventListener('dom-ready', function () {
      hideFloatOverlay(wv);
      // 全局设置：新标签首次加载完成后注入壳层设置（与已存在标签的广播保持一致）
      applyShellSettingsToWebview(wv);
      if (id === activeId) {
        // 重新应用当前标签的视图状态（懒加载标签首次加载完成后，确保 #chat-view 正确盖住 webview）
        applyViewModeForTab(findTab(id));
        syncRightBar();
        syncSessionList();
        applyDevMode();
        if (window.AgentView && window.AgentView.isVisible()) window.AgentView.refresh(true);
      }
    });

    // 需求2：webview 内 DOM 变化（消息/生成状态/附件）即时通知壳层 → 事件驱动同步。
    wv.addEventListener('ipc-message', function (e) {
      if (!e || e.channel !== 'tokfree-dom-changed') return;
      onWebviewDomChanged(id);
    });

    containerEl.appendChild(wv);
    webviews.set(id, wv);
    // loaded：该标签是否已真正加载过网页（懒加载标签首次切到时置 true）
    // pageReady：非懒加载标签已在加载中（未就绪），等 did-finish-load 置 true；懒加载标签切过去后才加载。
    tabs.push({ id: id, profileId: profileId, partition: partition, title: name || 'DeepSeek', url: url, viewMode: viewMode, loaded: !lazy, bootTracked: bootTracked, bootSettled: false, pageReady: false });
    if (bootTracked && !lazy) bootArmTimeout(id, name || 'DeepSeek');
    renderTabs();
    // activate=false：恢复标签时先不激活（避免懒加载标签被立即 switch 触发 loadURL）；
    // 由 restoreTabs 在所有标签建好后统一激活目标标签。
    if (opts.activate !== false) switchTab(id);
    persistTabs();
    return id;
  }

  // 隐藏 webview 内的悬浮窗（#tokfree-overlay 面板 + #tokfree-status-badge 悬浮球）。
  // 只隐藏、不删除 DOM：右栏的转发点击仍依赖这些按钮存在。
  function hideFloatOverlay(wv) {
    if (!wv) return;
    // 加固：样式表 !important + 内联 !important + MutationObserver 持续压制 + 周期兜底。
    // 只隐藏不删除 DOM：右栏的转发点击仍依赖这些元素存在（程序化 click 对 display:none 元素依然有效）。
    var code =
      '(function(){' +
      'var IDS=["tokfree-overlay","tokfree-status-badge"];' +
      'function ensureStyle(){' +
      '  var s=document.getElementById("tokfree-hide-float");' +
      '  if(!s){s=document.createElement("style");s.id="tokfree-hide-float";(document.head||document.documentElement).appendChild(s);}' +
      '  var css="#tokfree-overlay,#tokfree-status-badge{display:none !important;visibility:hidden !important;opacity:0 !important;pointer-events:none !important;}";' +
      '  if(s.textContent!==css)s.textContent=css;' +
      '}' +
      'function force(){' +
      '  for(var i=0;i<IDS.length;i++){var el=document.getElementById(IDS[i]);if(!el)continue;' +
      '    try{el.style.setProperty("display","none","important");el.style.setProperty("pointer-events","none","important");}' +
      '    catch(e){el.style.display="none";}}' +
      '}' +
      'ensureStyle();force();' +
      'if(!window.__tokfreeFloatGuard){' +
      '  window.__tokfreeFloatGuard=true;' +
      '  try{var mo=new MutationObserver(function(){ensureStyle();force();});' +
      '    mo.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["style","class"]});}catch(e){}' +
      '  setInterval(function(){ensureStyle();force();},3000);' +
      '}' +
      'return true;' +
      '})()';
    try { wv.executeJavaScript(code, true).catch(function () {}); } catch (_) {}
  }

  // 应用某个标签的视图状态到壳层界面（#chat-view 显隐 + 复位临时露出状态 + 切换按钮文案）。
  // ★ 切换标签时【先】调用它把 #chat-view 盖好（agent 模式），【再】切 webview 的 display，
  //   保证 webview 不会出现「没有被 #chat-view 盖住」的一帧 → 消除闪网页。
  function applyViewModeForTab(t) {
    var isApi = isApiProviderTab(t);
    // API 型平台（api-openai）固定 Agent 视图，不允许切到网页视图
    var mode = isApi ? 'agent' : ((t && t.viewMode) ? t.viewMode : 'agent');
    if (isApi && t) t.viewMode = 'agent';
    var agent = (mode === 'agent');
    var cvEl = document.getElementById('chat-view');
    if (cvEl) cvEl.classList.remove('cv-reveal-web');
    webRevealed = false;
    if (window.AgentView) window.AgentView.setVisible(agent);
    if (window.ProcessCapsule) {
      window.ProcessCapsule.setProfile(t ? (t.profileId || '') : '');
      window.ProcessCapsule.setVisible(agent);
    }
    if (viewToggleBtn) viewToggleBtn.textContent = agent ? '查看网页' : 'Agent 界面';
    // API 型平台：隐藏「查看网页」按钮，改为在 Agent 视图顶部展示配置条
    var apiBar = document.getElementById('cv-apiconfig');
    if (isApi) {
      if (viewToggleBtn) viewToggleBtn.classList.add('cv-hidden');
      if (apiBar) apiBar.classList.remove('cv-hidden');
      bindApiConfigBarOnce();
      loadApiConfigIntoBar(t);
    } else {
      if (viewToggleBtn) viewToggleBtn.classList.remove('cv-hidden');
      if (apiBar) apiBar.classList.add('cv-hidden');
    }
  }

  // 标签后台节流：切标签时，非活动标签的 webview 启用 Chromium 节流（省 CPU/内存），
  // 活动标签关闭节流（保证响应流畅）。经 shellAPI 走主进程按 profileId 反查 guest webContents 设置。
  function applyTabThrottling(activeTabId) {
    if (!window.shellAPI || typeof window.shellAPI.setTabThrottled !== 'function') return;
    tabs.forEach(function (t) {
      if (!t || !t.profileId) return;
      try { window.shellAPI.setTabThrottled(t.profileId, t.id !== activeTabId); } catch (_) {}
    });
  }

  function switchTab(id) {
    if (!webviews.has(id)) return;
    var t = findTab(id);
    // 先设 activeId，保证 applyViewModeForTab 触发的 AgentView.refresh 作用在目标标签的 webview 上。
    activeId = id;
    // 需求3：切到该标签 profile 的缓存上下文 —— 先同步渲染该标签缓存消息（切换瞬间出内容），
    // 再由 applyViewModeForTab → setVisible(true) → refresh(true) 在后台拉取最新内容。
    if (window.AgentView && window.AgentView.setActiveProfile) {
      window.AgentView.setActiveProfile(t ? (t.profileId || '') : '');
    }
    // ★ 先按目标标签的视图状态盖好 #chat-view（agent 模式），再切 webview 的 display。
    applyViewModeForTab(t);
    // 需求1：切换标签时同步「页面是否就绪」（未加载完的标签 → 不显示初始化横幅）
    syncPageReady();
    webviews.forEach(function (wv, tid) {
      wv.style.display = (tid === id) ? 'flex' : 'none';
    });
    // 标签后台节流：非活动标签的 webview 启用 Chromium 节流（省 CPU/内存），
    // 活动标签关闭节流（保证响应流畅）。拿 guest webContents 走主进程按 profileId 反查。
    applyTabThrottling(id);
    // 懒加载标签：首次切到该标签时再真正加载（避免启动/恢复时后台标签抢带宽）。
    // ★ 必须在 webview 变为可见（display:flex）之后再触发加载：
    //   display:none 的 <webview> 不会 attach guest webContents，主进程 did-attach-webview
    //   不触发，该 profile 就无法注册进 windowState（无 UA 伪装/请求头修正/tokfree 上下文），
    //   表现为"重启后第 2、3…个标签连不上"。
    // ★ 用 setAttribute('src') 触发，走与 createTab 非懒加载（及窗口管理打开对应窗口）
    //   完全一致的 attach 路径，保证行为一致。
    if (t && !t.loaded) {
      t.loaded = true;
      var wvLazy = webviews.get(id);
      try {
        if (wvLazy && !wvLazy.getAttribute('src')) {
          wvLazy.setAttribute('src', t.url || DEFAULT_URL);
        } else if (wvLazy) {
          wvLazy.loadURL(t.url || DEFAULT_URL);
        }
      } catch (_) {}
    }
    // 每个标签独立会话高亮：切标签时恢复该标签的当前会话 ID
    curSessionId = (t && t.sessionId) || null;
    // 刷新「每标签」工具模式/信任模式控件为该标签的值
    if (typeof refreshCvPolicyBar === 'function') refreshCvPolicyBar();
    // 深度思考开关：每标签独立状态，切标签时同步一次（含首次默认开启）
    if (typeof syncDeepThinkFromWeb === 'function') syncDeepThinkFromWeb();
    renderTabs();
    if (typeof refreshCvAccount === 'function') refreshCvAccount();
    // ★ 右栏/会话同步改为异步去抖，避免同步调用阻塞切换造成卡顿。
    scheduleSideSync();
    // 全局面板若开着：刷新活动项高亮（面板在壳层，跨标签常驻）
    if (typeof isShellWindowManagerOpen === 'function' && isShellWindowManagerOpen()) {
      renderShellWindowList();
    }
    // providerId 未知（新标签/首次启动）：异步刷新映射，拿到后会自动重评估当前标签
    if (t && t.profileId && !(t.profileId in profileProviderMap)) {
      refreshProfileProviderMap();
    }
    persistTabs();
  }

  // 需求D：刷新标题下方的账号名（优先取活动 webview 网页实际登录账号，profile 绑定兜底）
  var cvAccountReqSeq = 0;
  // 自包含探测代码：在活动 webview 内探测实际登录邮箱（DOM + localStorage 双策略）
  function buildAccountProbeCode() {
    var sels = JSON.stringify(['[class*="user"] [class*="email"]', '[class*="avatar"]', '[class*="userInfo"]', '[class*="user-info"]']);
    return '(function(){try{' +
      'var sels=' + sels + ';' +
      'for(var i=0;i<sels.length;i++){var els=document.querySelectorAll(sels[i]);' +
      'for(var j=0;j<els.length;j++){var el=els[j];' +
      'var c=(el.getAttribute&&(el.getAttribute("title")||el.getAttribute("alt")||el.getAttribute("aria-label")))||el.textContent||"";' +
      'var m=String(c).match(/[\\w.+-]+@[\\w-]+\\.[\\w.]+/);if(m)return m[0];}}' +
      'try{for(var k=0;k<localStorage.length;k++){var key=localStorage.key(k);var v=localStorage.getItem(key)||"";' +
      'if(/user|account|profile|info|token/i.test(key)&&v.indexOf("@")!==-1){var mm=v.match(/[\\w.+-]+@[\\w-]+\\.[\\w.]+/);if(mm)return mm[0];}}}catch(_){}' +
      'return "";}catch(e){return "";}})()';
  }
  function refreshCvAccount() {
    var el = document.getElementById('cv-account');
    if (!el) return;
    var t = findTab(activeId);
    var pid = t ? (t.profileId || '') : '';
    var seq = ++cvAccountReqSeq;
    // 绑定标签（最高优先级）：账号池 label > profile.account.label
    var boundLabel = '';
    // profile.account.email（最低优先级兜底）
    var profEmail = '';

    function setText(v) {
      if (seq !== cvAccountReqSeq) return;
      var e = document.getElementById('cv-account');
      if (e) e.textContent = (v == null ? '' : String(v).trim());
    }

    // 读 profile 绑定 + 账号池 label（按 accountId 查账号池）
    function applyBoundAccount() {
      if (!pid || !window.shellAPI || !window.shellAPI.listProfiles) {
        setText('');
        return Promise.resolve(false);
      }
      return window.shellAPI.listProfiles().then(function (res) {
        if (seq !== cvAccountReqSeq) return false;
        var profiles = (res && res.success && res.profiles) ? res.profiles : [];
        var p = null;
        for (var i = 0; i < profiles.length; i++) { if (profiles[i].id === pid) { p = profiles[i]; break; } }
        var acc = p && p.account ? p.account : null;
        var accountId = acc ? acc.accountId : '';
        profEmail = (acc && acc.email) || '';
        boundLabel = (acc && acc.label) || '';

        function writeBound() {
          if (seq !== cvAccountReqSeq) return;
          setText(boundLabel);
        }

        if (accountId && window.shellAPI.accountList) {
          return window.shellAPI.accountList().then(function (ar) {
            if (seq !== cvAccountReqSeq) return false;
            var list = (ar && ar.success && ar.accounts) ? ar.accounts : [];
            var poolLabel = '';
            for (var k = 0; k < list.length; k++) {
              if (list[k].id === accountId) {
                poolLabel = (list[k].label && String(list[k].label).trim()) || (list[k].username && String(list[k].username).trim()) || '';
                break;
              }
            }
            if (poolLabel) boundLabel = poolLabel;
            writeBound();
            return !!boundLabel;
          }).catch(function () { writeBound(); return !!boundLabel; });
        }
        writeBound();
        return !!boundLabel;
      }).catch(function () { return false; });
    }

    // 主路径：从活动 webview 读取网页实际登录账号
    var wv = getActiveWebview();
    if (!wv) {
      applyBoundAccount().then(function (hasBound) {
        if (seq !== cvAccountReqSeq) return;
        if (!hasBound) setText(profEmail);
      });
      return;
    }
    execInActive(buildAccountProbeCode()).then(function (found) {
      if (seq !== cvAccountReqSeq) return;
      var email = (found && String(found).trim()) || '';
      applyBoundAccount().then(function (hasBound) {
        if (seq !== cvAccountReqSeq) return;
        if (hasBound) return;            // 账号池 label / profile.account.label 优先
        if (email) { setText(email); return; } // 网页探测邮箱
        setText(profEmail);              // profile.account.email 兜底
      });
    }).catch(function () {
      if (seq !== cvAccountReqSeq) return;
      applyBoundAccount().then(function (hasBound) {
        if (seq !== cvAccountReqSeq) return;
        if (!hasBound) setText(profEmail);
      });
    });
  }

  // 切换标签后的右栏/会话列表同步去抖：合并同一批切换，避免连续点击时重复执行 JS。
  var sideSyncTimer = null;
  function scheduleSideSync() {
    if (sideSyncTimer) clearTimeout(sideSyncTimer);
    sideSyncTimer = setTimeout(function () {
      sideSyncTimer = null;
      syncRightBar();
      syncSessionList();
    }, 60);
  }

  // 需求2：webview DOM 变化 → 即时刷新（事件驱动，延迟从秒级降到即时）。
  // 壳层再节流 200ms，避免高频事件风暴造成重复 executeJavaScript。
  var domChangeThrottle = {};
  function onWebviewDomChanged(id) {
    if (id !== activeId) return; // 仅活动标签驱动壳层 UI
    if (domChangeThrottle[id]) return;
    domChangeThrottle[id] = setTimeout(function () {
      domChangeThrottle[id] = null;
      if (id !== activeId) return;
      // Agent 视图可见时按内容签名重绘（内容没变会自动跳过，避免无谓开销）
      if (window.AgentView && getViewMode() === 'agent' && window.AgentView.isVisible()) {
        window.AgentView.refresh(false);
      }
      // 同步执行态 / 右栏 / 附件 chips（一次 execInActive 读取）
      pollActiveWebview();
    }, 200);
  }

  function closeTab(id) {
    var wv = webviews.get(id);
    if (!wv) return;
    try { wv.remove(); } catch (_) {}
    webviews.delete(id);
    var idx = -1;
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].id === id) { idx = i; break; }
    }
    if (idx >= 0) tabs.splice(idx, 1);

    if (activeId === id) {
      var next = tabs[Math.min(idx, tabs.length - 1)];
      if (next) { switchTab(next.id); }
      else { activeId = null; curSessionId = null; syncSessionList(); }
    }
    renderTabs();
    lastPersistCount = tabs.length; // 用户主动关闭标签：同步计数，避免数量减少误报
    persistTabs();
  }

  // ===== 标签拖拽排序（浏览器式） =====
  var dragSrcIndex = -1;      // 被拖动标签在 tabs 中的下标
  var dragOverIndex = -1;     // 当前悬停标签的下标（插入位置：该标签之前）
  var suppressTabClick = false; // 拖拽结束后抑制一次 click，避免误触发 switchTab

  function clearDragOver() {
    var els = tabListEl.querySelectorAll('.tab.drag-over');
    for (var k = 0; k < els.length; k++) els[k].classList.remove('drag-over');
    dragOverIndex = -1;
  }

  // ===== 标签悬浮预览（单例浮层，所有标签共用） =====
  var tabPreviewEl = null;        // 浮层 DOM（懒创建）
  var tabPreviewHideTimer = null; // 延迟隐藏定时器
  var tabPreviewHovered = false;  // 鼠标是否停在浮层上
  var tabPreviewActiveId = null;  // 当前浮层对应的标签 id（异步回填防串台）

  function ensureTabPreview() {
    if (tabPreviewEl && document.body.contains(tabPreviewEl)) return tabPreviewEl;
    tabPreviewEl = document.createElement('div');
    tabPreviewEl.id = 'tab-preview';
    tabPreviewEl.className = 'tab-preview tab-preview-hidden';
    // 鼠标移入浮层：保持显示（取消隐藏）
    tabPreviewEl.addEventListener('mouseenter', function () {
      tabPreviewHovered = true;
      if (tabPreviewHideTimer) { clearTimeout(tabPreviewHideTimer); tabPreviewHideTimer = null; }
    });
    tabPreviewEl.addEventListener('mouseleave', function () {
      tabPreviewHovered = false;
      hideTabPreview();
    });
    document.body.appendChild(tabPreviewEl);
    return tabPreviewEl;
  }

  function hideTabPreview() {
    if (tabPreviewHideTimer) { clearTimeout(tabPreviewHideTimer); tabPreviewHideTimer = null; }
    tabPreviewActiveId = null;
    if (tabPreviewEl) tabPreviewEl.classList.add('tab-preview-hidden');
  }

  // 延迟隐藏：给「鼠标从标签移到浮层」留出时间，移入浮层时会被取消
  function scheduleHideTabPreview() {
    if (tabPreviewHideTimer) { clearTimeout(tabPreviewHideTimer); tabPreviewHideTimer = null; }
    tabPreviewHideTimer = setTimeout(function () {
      tabPreviewHideTimer = null;
      if (tabPreviewHovered) return;
      hideTabPreview();
    }, 150);
  }

  function showTabPreview(t, el) {
    var pv = ensureTabPreview();
    tabPreviewActiveId = t.id;

    // 内容：标题 / 账号（先占位 URL）/ profileId
    pv.textContent = '';
    var titleEl = document.createElement('div');
    titleEl.className = 'tp-title';
    titleEl.textContent = t.title || '新标签';
    var acctEl = document.createElement('div');
    acctEl.className = 'tp-account';
    acctEl.textContent = t.url || '';
    var idEl = document.createElement('div');
    idEl.className = 'tp-id';
    idEl.textContent = t.profileId || '';
    pv.appendChild(titleEl);
    pv.appendChild(acctEl);
    pv.appendChild(idEl);

    // 位置：左对齐标签，超出右边界则左移；标签下方 +4px
    pv.classList.remove('tab-preview-hidden');
    var rect = el.getBoundingClientRect();
    var left = rect.left;
    var maxLeft = window.innerWidth - pv.offsetWidth - 8;
    if (left > maxLeft) left = Math.max(8, maxLeft);
    pv.style.left = left + 'px';
    pv.style.top = (rect.bottom + 4) + 'px';

    // 异步补充：优先显示该标签绑定账号的 label/email，取不到则保留 URL
    if (t.profileId && window.shellAPI && window.shellAPI.listProfiles) {
      window.shellAPI.listProfiles().then(function (res) {
        if (tabPreviewActiveId !== t.id) return; // 已切到别的标签/已隐藏
        var profiles = (res && res.success && res.profiles) ? res.profiles : [];
        var p = null;
        for (var i = 0; i < profiles.length; i++) {
          if (profiles[i].id === t.profileId) { p = profiles[i]; break; }
        }
        var acc = p && p.account ? p.account : null;
        var label = (acc && (acc.label || acc.email)) || '';
        if (label) acctEl.textContent = label;
      }).catch(function () {});
    }
  }

  function renderTabs() {
    tabListEl.innerHTML = '';
    for (var i = 0; i < tabs.length; i++) {
      (function (t, idx) {
        var el = document.createElement('div');
        el.className = 'tab' + (t.id === activeId ? ' active' : '');
        el.setAttribute('draggable', 'true');

        var statusSpan = document.createElement('span');
        statusSpan.className = 'tab-status ' + tabStatusClass(t.profileId);
        statusSpan.setAttribute('data-profile-id', t.profileId || '');

        // 角色徽章（主/次）：数据来自 listWindowsStatus 轮询缓存，下方 applyTabStatusClasses 会就地更新
        var roleBadge = document.createElement('span');
        roleBadge.className = 'tab-role-badge';
        roleBadge.setAttribute('data-profile-id', t.profileId || '');
        applyRoleBadge(roleBadge, t.profileId);

        var titleSpan = document.createElement('span');
        titleSpan.className = 'tab-title';
        titleSpan.textContent = t.title || '新标签';
        titleSpan.title = t.url || '';

        var closeBtn = document.createElement('button');
        closeBtn.className = 'tab-close';
        closeBtn.textContent = '×';
        closeBtn.title = '关闭标签';
        closeBtn.setAttribute('draggable', 'false');
        closeBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          closeTab(t.id);
        });

        el.appendChild(statusSpan);
        el.appendChild(roleBadge);
        el.appendChild(titleSpan);
        el.appendChild(closeBtn);

        el.addEventListener('click', function () {
          if (suppressTabClick) return;
          switchTab(t.id);
        });

        // 中键关闭标签（auxclick 处理关闭；mousedown 兜底阻止中键自动滚动）
        el.addEventListener('auxclick', function (e) {
          if (e.button === 1) {
            e.preventDefault();
            closeTab(t.id);
          }
        });
        el.addEventListener('mousedown', function (e) {
          if (e.button === 1) e.preventDefault();
        });

        // 悬浮预览：延迟 400ms 显示；移开延迟隐藏（移入浮层不隐藏）
        var previewTimer = null;
        el.addEventListener('mouseenter', function () {
          if (previewTimer) clearTimeout(previewTimer);
          previewTimer = setTimeout(function () {
            previewTimer = null;
            // 定时器触发时标签可能已被移除
            if (!findTab(t.id)) return;
            showTabPreview(t, el);
          }, 400);
        });
        el.addEventListener('mouseleave', function () {
          if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
          scheduleHideTabPreview();
        });

        // 开始拖拽：记录源下标，标记 dragging
        el.addEventListener('dragstart', function (e) {
          dragSrcIndex = idx;
          suppressTabClick = true;
          el.classList.add('dragging');
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', String(idx)); } catch (_) {}
          }
        });

        // 悬停到目标标签：preventDefault 让 drop 生效，显示插入指示线
        el.addEventListener('dragover', function (e) {
          if (dragSrcIndex < 0 || idx === dragSrcIndex) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          if (dragOverIndex !== idx) {
            clearDragOver();
            dragOverIndex = idx;
            el.classList.add('drag-over');
          }
        });

        el.addEventListener('dragleave', function () {
          el.classList.remove('drag-over');
          if (dragOverIndex === idx) dragOverIndex = -1;
        });

        // 放下：把源标签插入到目标标签之前，重排 tabs 并持久化
        el.addEventListener('drop', function (e) {
          e.preventDefault();
          e.stopPropagation();
          var from = dragSrcIndex;
          var before = idx;
          clearDragOver();
          if (from < 0 || from === before) return;
          var item = tabs.splice(from, 1)[0];
          var at = (from < before) ? before - 1 : before;
          tabs.splice(at, 0, item);
          renderTabs();
          persistTabs();
        });

        // 拖拽结束：清理状态，延迟解除 click 抑制（click 在 dragend 之后异步触发）
        el.addEventListener('dragend', function () {
          el.classList.remove('dragging');
          clearDragOver();
          dragSrcIndex = -1;
          setTimeout(function () { suppressTabClick = false; }, 0);
        });

        tabListEl.appendChild(el);
      })(tabs[i], i);
    }
    if (typeof refreshCvAccount === 'function') refreshCvAccount();
  }

  newTabBtn.addEventListener('click', function () { openPlatformSelect(); });

  // ===== 主进程 → 壳层命令（打开/替换标签） =====
  // create-profile-window / open-profile-window / team_create_window / select-platform
  // 统一收口到此处，不再弹新 BrowserWindow。
  function handleShellCommand(payload) {
    if (!payload || typeof payload !== 'object') return;
    var url = payload.url || DEFAULT_URL;
    var name = payload.name || 'DeepSeek';
    var existing = payload.profileId ? findTabByProfile(payload.profileId) : null;

    if (payload.type === 'replace' && existing) {
      // 替换标签（切平台后 partition 变化，webview 的 partition 属性不可变，必须重建）
      var wasActive = (activeId === existing.id);
      var idx = tabs.indexOf(existing);
      closeTab(existing.id);
      createTab({
        profileId: payload.profileId,
        partition: payload.partition,
        url: url,
        name: name,
      }).then(function (newId) {
        // 尽量恢复原位置/激活状态
        var i = tabs.length - 1;
        if (idx >= 0 && idx < tabs.length - 1 && i > idx) {
          var t = tabs.splice(i, 1)[0];
          tabs.splice(idx, 0, t);
          renderTabs();
        }
        if (wasActive) switchTab(newId);
      });
      return;
    }

    if (existing) {
      // 已打开：聚焦即可
      switchTab(existing.id);
      return;
    }
    createTab({
      profileId: payload.profileId,
      partition: payload.partition,
      url: url,
      name: name,
    });
  }

  if (window.shellAPI && window.shellAPI.onShellCommand) {
    window.shellAPI.onShellCommand(handleShellCommand);
  }

  // 主进程 → 壳层命令（关闭标签）：删除窗口时联动关闭对应标签页
  if (window.shellAPI && window.shellAPI.onShellCloseTab) {
    window.shellAPI.onShellCloseTab(function (payload) {
      if (!payload || !payload.profileId) return;
      var t = findTabByProfile(payload.profileId);
      if (t) closeTab(t.id);
    });
  }

  // 壳窗口快捷键：Ctrl+T 新标签 / Ctrl+W 关标签
  if (window.shellAPI && window.shellAPI.onShellShortcut) {
    window.shellAPI.onShellShortcut(function (action) {
      if (action === 'new-tab') createTab();
      else if (action === 'close-tab' && activeId) closeTab(activeId);
    });
  }

  // 启动：初始化加载遮罩，再恢复上次打开的标签（无持久化数据则开 1 个默认标签）
  bootInit();
  restoreTabs();

  // ===== 右侧功能区：转发给当前活动 webview 内的 overlay 执行 =====
  function getActiveWebview() {
    if (!activeId) return null;
    return webviews.get(activeId) || null;
  }

  function execInActive(code) {
    var wv = getActiveWebview();
    if (!wv) return Promise.reject(new Error('没有活动标签'));
    try {
      return wv.executeJavaScript(code, true);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  // ===== 临时露出 webview（Agent 视图下点击右栏按钮，让 webview 内的 overlay 面板可见）=====
  var webRevealed = false;
  var revealGraceUntil = 0;
  var PANEL_IDS = ['tokfree-window-manager','tokfree-mcp-manager','tokfree-knowledge-manager',
    'tokfree-account-pool','tokfree-settings-drawer','tokfree-mission-control',
    'tokfree-first-time-dialog','tokfree-acct-select-dialog','tokfree-cp-mask',
    'tokfree-ob-mask','tokfree-about-mask','tokfree-retry-countdown'];
  var PANEL_CLASSES = ['tokfree-window-manager','tokfree-settings-drawer',
    'tokfree-first-time-dialog','tokfree-retry-countdown'];

  // 在活动 webview 内一次性读取「是否有面板可见」+「AI 是否在执行」
  function buildWebStatusCode() {
    var ids = JSON.stringify(PANEL_IDS);
    var cls = JSON.stringify(PANEL_CLASSES);
    // 停止按钮选择器：与各 provider 的 isGenerating 对齐（AI 纯生成期间也命中 → running=true）。
    // querySelector 只返回首个匹配（若为隐藏元素会误判）；故用 querySelectorAll 逐个判可见。
    var stopSels = JSON.stringify([
      '[aria-label*="停止"]', '[title*="停止"]', '[aria-label*="Stop"]', '[aria-label*="stop"]', '[title*="Stop"]',
      'button[data-testid="stop-button"]', '[class*="stop-button"]', 'button[class*="stop"]'
    ]);
    return '(function(){' +
      'function vis(el){if(!el)return false;' +
      'if(el.classList&&el.classList.contains("tokfree-hidden"))return false;' +
      'var cs=getComputedStyle(el);' +
      'if(cs.display==="none"||cs.visibility==="hidden")return false;' +
      'if(parseFloat(cs.opacity||"1")<0.05)return false;return true;}' +
      'var ids=' + ids + ';var panel=false;' +
      'for(var i=0;i<ids.length;i++){if(vis(document.getElementById(ids[i]))){panel=true;break;}}' +
      'var cls=' + cls + ';' +
      'if(!panel){for(var j=0;j<cls.length;j++){var arr=document.getElementsByClassName(cls[j]);' +
      'for(var k=0;k<arr.length;k++){if(vis(arr[k])){panel=true;break;}}if(panel)break;}}' +
      'var ts=document.getElementById("tokfree-task-status");' +
      'var tsActive=!!(ts && !ts.classList.contains("tokfree-hidden"));' +
      'var gen=false;var _sels=' + stopSels + ';' +
      'try{for(var _si=0;_si<_sels.length&&!gen;_si++){var _els=document.querySelectorAll(_sels[_si]);' +
      'for(var _ei=0;_ei<_els.length;_ei++){var _e=_els[_ei];if(_e&&_e.offsetWidth>0){gen=true;break;}}}}catch(e){}' +
      'var running=tsActive||gen;' +
      'var d=document.querySelector("#tokfree-project-dir-display .tokfree-dir-path");' +
      'var q=document.getElementById("tokfree-btn-quick-login");' +
      'var tk=document.getElementById("tokfree-conv-token-count");' +
      'var tm=document.getElementById("tokfree-team-mode-toggle");' +
      'var ats=[];' +
      'try{if(window.electronAPI&&window.electronAPI.readPendingAttachments){var _a=window.electronAPI.readPendingAttachments();' +
      'if(_a&&_a.length){for(var _i=0;_i<_a.length;_i++){ats.push({name:_a[_i].name,kind:_a[_i].kind,thumb:""});}}}}catch(e){}' +
      'return {panel:panel, running:running, dir:(d&&d.textContent)||"", login: !!(q && !q.classList.contains("tokfree-hidden")), token:(tk&&tk.textContent)||"0", team: !!(tm&&tm.checked), atts:ats};' +
      '})()';
  }

  function setWebRevealed(on) {
    if (on && getViewMode() !== 'agent') on = false;
    if (!on && Date.now() < revealGraceUntil) return; // 点击后短暂宽限期，避免面板尚未出现就被收起
    if (on === webRevealed) return;
    webRevealed = on;
    var chatView = document.getElementById('chat-view');
    if (chatView) chatView.classList.toggle('cv-reveal-web', on);
    if (!on && window.AgentView && AgentView.isVisible()) AgentView.refresh(true);
  }

  function updateExecStatus(running) {
    var el = document.getElementById('rb-exec-status');
    if (!el) return;
    if (running) {
      el.className = 'rb-exec-status rb-exec-running';
      el.innerHTML = '<span class="rb-exec-spinner"></span>正在执行';
    } else {
      el.className = 'rb-exec-status rb-exec-idle';
      el.textContent = '空闲';
    }
  }

  // ===== 「停止生成」按钮显隐状态（AI 生成中 或 本地执行中 都显示）=====
  var cvAgentGenerating = false; // 来自 AgentView 的 onGenerating 回调（AI 正在生成文本）
  var cvWebRunning = false;      // 来自 webview 状态轮询（本地代码块执行 / 网页端停止键可见）
  var cvTaskActive = false;      // 来自 ProcessCapsule.onActiveChange（plan/todo 任务未完成 → 工作中）
  function updateStopBtn() { syncStopBtn(cvAgentGenerating || cvWebRunning); }

  // 判断指定标签的页面是否已就绪（默认视为未就绪，直到 did-finish-load）
  function isTabReady(t) {
    return !!(t && t.pageReady === true);
  }

  // 把「活动标签页面是否就绪」同步给 Agent 视图（加载中 → 不显示初始化横幅）
  function syncPageReady() {
    var ready = isTabReady(findTab(activeId));
    if (window.AgentView && window.AgentView.setPageReady) {
      window.AgentView.setPageReady(ready);
    }
  }

  // 把 webview 读取到的状态渲染到右侧栏（含同步项目目录给 Agent 视图）
  function applyRightBarFromWeb(r) {
    var dirEl = document.getElementById('rb-project-dir');
    var loginBtn = document.getElementById('rb-btn-quick-login');
    var tokenEl = document.getElementById('rb-token-count');
    var teamEl = document.getElementById('rb-team-mode');
    var dir = (r && r.dir) ? String(r.dir).trim() : '';
    if (dirEl) {
      dirEl.textContent = dir || '未选择';
      dirEl.title = dir || '';
    }
    // 需求1：把当前活动标签的项目目录同步给 Agent 视图（空 → 显示初始化横幅）
    if (window.AgentView && window.AgentView.setProjectDir) {
      window.AgentView.setProjectDir(dir);
    }
    // 需求1：把「页面是否就绪」同步给 Agent 视图（加载中 → 显示加载横幅，不显示初始化横幅）
    var pageReady = isTabReady(findTab(activeId));
    if (window.AgentView && window.AgentView.setPageReady) {
      window.AgentView.setPageReady(pageReady);
    }
    // 需求1：把登录态同步给 Agent 视图（未登录 → 显示登录横幅 / 隐藏 Agent 内容）
    // 页面未就绪时按「需要登录」处理，确保加载中绝不显示「初始化项目」按钮。
    var onLogin = !pageReady || !!(r && r.login);
    if (window.AgentView && window.AgentView.setLoginState) {
      window.AgentView.setLoginState(onLogin);
    }
    // 需求1：把「AI 是否正在工作」同步给 Agent 视图（webview 内 #tokfree-task-status 可见性），
    // 控制输入栏上方「AI 正在运行中」提示条显隐（AI 执行工具/代码期间也显示）。
    if (window.AgentView && window.AgentView.setRunning) {
      window.AgentView.setRunning(!!(r && r.running));
    }
    if (window.ProcessCapsule && window.ProcessCapsule.setRunning) {
      window.ProcessCapsule.setRunning(!!(r && r.running));
    }
    // 同步「停止生成」按钮显隐：本地执行中记录 webview 状态，最终显隐由 updateStopBtn 统一决定
    cvWebRunning = !!(r && r.running);
    updateStopBtn();
    // 登录页自动切回网页视图；登录成功后自动切回 Agent 视图
    notifyLoginState(onLogin);
    if (loginBtn) {
      if (r && r.login) loginBtn.classList.remove('rb-hidden');
      else loginBtn.classList.add('rb-hidden');
    }
    if (tokenEl) tokenEl.textContent = (r && r.token) ? String(r.token).trim() : '0';
    // 自动压缩上下文：token 达到阈值时触发（受勾选开关控制）
    maybeAutoCompact((r && r.token) ? String(r.token).trim() : '0');
    if (teamEl) teamEl.checked = !!(r && r.team);
    // 需求1b：实时显示网页输入区已挂载的待发送附件
    // （网页端上传 / 壳端📎 / 拖拽 三种来源统一从此读取，壳端都能看到）
    renderAttachments(r && r.atts);
  }

  // 需求1b：渲染「待发送附件」chip（输入框上方）
  // 图片类：显示真实缩略图（dataURL）+ 文件名；文件类：显示图标 + 文件名。
  // 缩略图缓存：同步轮询只带文件名（thumb 为空），异步轮询才带 dataURL。
  // 用缓存避免同步轮询把已显示的缩略图擦成图标（每 5s 一次闪烁）。
  var attachThumbCache = {};
  // 需求1b：待发附件 chip 的「×」删除按钮（事件委托，只绑一次）
  function onAttachDelClick(ev) {
    var t = ev.target;
    if (!t || !t.classList || !t.classList.contains('cv-attach-del')) return;
    var name = t.getAttribute('data-name') || '';
    if (!name) return;
    var code = 'window.electronAPI && window.electronAPI.removePendingAttachment' +
      ' ? window.electronAPI.removePendingAttachment(' + JSON.stringify(name) + ')' +
      ' : Promise.resolve({success:false,error:"removePendingAttachment 不可用"})';
    execInActive(code).then(function (r) {
      if (r && r.success) {
        pollAttachmentsAsync();
      } else {
        var msg = (r && r.error) ? r.error : '移除失败';
        if (typeof shellToast === 'function') shellToast(msg); else console.warn('[shell] 移除附件失败:', msg);
      }
    }).catch(function (e) {
      var msg = (e && e.message) || String(e);
      if (typeof shellToast === 'function') shellToast('移除附件异常：' + msg); else console.warn('[shell] 移除附件异常:', msg);
    });
  }
  function renderAttachments(atts) {
    var box = document.getElementById('cv-attachments');
    if (!box) return;
    if (!box._attachDelBound) {
      box._attachDelBound = true;
      box.addEventListener('click', onAttachDelClick);
    }
    var list = Array.isArray(atts) ? atts : [];
    if (!list.length) {
      if (box.childNodes.length) box.innerHTML = '';
      box.classList.add('cv-hidden');
      attachThumbCache = {}; // 附件清空，缓存一并清掉，避免同名残留旧图
      return;
    }
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var a = list[i] || {};
      var name = String(a.name || '附件');
      var thumb = String(a.thumb || '');
      // 有 dataURL 就更新缓存；没有则回退到缓存里上次拿到的 dataURL
      if (thumb && thumb.indexOf('data:') === 0) {
        attachThumbCache[name] = thumb;
      } else {
        thumb = attachThumbCache[name] || '';
      }
      var title = attrEsc(name);
      var del = '<span class="cv-attach-del" data-name="' + title + '" title="移除">×</span>';
      if (a.kind === 'image' && thumb) {
        html += '<span class="cv-attach-chip cv-attach-chip-img" title="' + title + '">' +
                '<img class="cv-attach-thumb" src="' + attrEsc(thumb) + '" alt="" />' +
                '<span class="cv-attach-name">' + attrEsc(name) + '</span>' +
                del +
                '</span>';
      } else {
        var icon = (a.kind === 'image') ? '🖼 ' : '📄 ';
        html += '<span class="cv-attach-chip" title="' + title + '">' + icon + attrEsc(name) + del + '</span>';
      }
    }
    box.innerHTML = html;
    box.classList.remove('cv-hidden');
  }

  var webPollBusy = false;
  function pollActiveWebview() {
    if (webPollBusy) return;
    var wv = getActiveWebview();
    if (!wv) {
      setWebRevealed(false);
      // 无 webview 时：DOM 信号缺失，但任务活跃（cvTaskActive）仍应显示「正在执行」。
      updateExecStatus(cvTaskActive);
      applyRightBarFromWeb(null);
      return;
    }
    webPollBusy = true;
    execInActive(buildWebStatusCode()).then(function (r) {
      setWebRevealed(!!(r && r.panel));
      updateExecStatus(!!(r && r.running) || cvTaskActive);
      applyRightBarFromWeb(r);
      // 深度思考开关：随状态轮询一起从网页端同步（含首次默认开启）
      syncDeepThinkFromWeb();
      // 需求1b：同步结果只给了文件名（图片 thumb 置空，避免 blob 破图）；
      // 再异步取一次 dataURL 缩略图做「渐进增强」，让壳层显示真实缩略图。
      pollAttachmentsAsync();
    }).catch(function () {}).then(function () { webPollBusy = false; });
  }

  // 需求1b：异步拉取「带 dataURL 缩略图」的附件列表并重渲染。
  // 在 webview 内 fetch(blob) → FileReader.readAsDataURL 转成 dataURL 后返回；
  // blob URL 跨上下文不可用，转成内联 dataURL 后壳层 <img> 才能加载出图。
  function pollAttachmentsAsync() {
    var wv = getActiveWebview();
    if (!wv) return;
    execInActive('window.electronAPI && window.electronAPI.readPendingAttachmentsAsync ? window.electronAPI.readPendingAttachmentsAsync() : Promise.resolve([])')
      .then(function (list) { renderAttachments(list); })
      .catch(function () {});
  }
  // 合并原 pollActiveWebview(1.2s) 与 syncRightBar(3s)：一次读取同时驱动面板/执行态/右栏。
  // 需求2：改为「事件驱动为主」——webview 内 DOM 变化即时触发（见 onWebviewDomChanged），
  // 此处仅作 5s 低频兜底，防漏事件。
  setInterval(pollActiveWebview, 5000);

  // ===== 标签状态标识（与「窗口管理」同一数据源 list-windows-status）=====
  // state: idle | busy | warn | banned
  //   busy        → 转圈动画
  //   idle        → 绿色圆点
  //   warn/banned → 红色圆点
  // 计算某 profileId 应显示的 class（供 renderTabs 初次渲染用）
  function tabStatusClass(profileId) {
    if (!profileId) return 'tab-status ts-idle';
    var state = (tabStatusMap || {})[profileId] || 'idle';
    return 'tab-status ' + tabStateClass(state);
  }

  function tabStateClass(state) {
    if (state === 'busy') return 'ts-busy';
    if (state === 'warn' || state === 'banned') return 'ts-warn';
    return 'ts-idle';
  }

  // 拉取状态并「就地」更新已渲染标签的状态标识（不重建 tab 列表，保留点击/拖拽逻辑）
  function refreshTabStatuses() {
    if (tabStatusInFlight) return;
    if (!window.shellAPI || !window.shellAPI.listWindowsStatus) return;
    if (!tabs.length) return;
    tabStatusInFlight = true;
    window.shellAPI.listWindowsStatus().then(function (res) {
      tabStatusInFlight = false;
      var list = (res && res.success && res.windows) ? res.windows : [];
      var map = {};
      var roleMap = {};
      list.forEach(function (w) {
        if (w && w.profileId) {
          map[w.profileId] = w.state || 'idle';
          if (w.role) roleMap[w.profileId] = w.role;
        }
      });
      tabStatusMap = map;
      tabRoleMap = roleMap;
      applyTabStatusClasses();
    }).catch(function () { tabStatusInFlight = false; });
  }

  // 只更新状态标识元素的 class，避免重建整个标签列表
  function applyTabStatusClasses() {
    if (!tabListEl) return;
    var els = tabListEl.querySelectorAll('.tab .tab-status');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var pid = el.getAttribute('data-profile-id') || '';
      var state = pid ? ((tabStatusMap || {})[pid] || 'idle') : 'idle';
      var cls = 'tab-status ' + tabStateClass(state);
      if (el.className !== cls) el.className = cls;
    }
    // 就地更新角色徽章（主/次）
    var badges = tabListEl.querySelectorAll('.tab .tab-role-badge');
    for (var j = 0; j < badges.length; j++) {
      var b = badges[j];
      applyRoleBadge(b, b.getAttribute('data-profile-id') || '');
    }
  }

  // 根据缓存中的角色设置徽章显示/样式（无角色则隐藏）
  function applyRoleBadge(el, profileId) {
    if (!el) return;
    var role = profileId ? ((tabRoleMap || {})[profileId] || '') : '';
    if (role === 'master') {
      el.textContent = '主';
      el.title = '主大脑';
      el.className = 'tab-role-badge tab-role-master';
    } else if (role === 'worker') {
      el.textContent = '次';
      el.title = '子 Agent';
      el.className = 'tab-role-badge tab-role-worker';
    } else {
      el.textContent = '';
      el.title = '';
      el.className = 'tab-role-badge tab-role-none';
    }
  }

  // 1.5s 轮询一次（比窗口管理的按需刷新略勤，但远低于标签重绘成本）
  setInterval(refreshTabStatuses, 1500);
  refreshTabStatuses();

  // 面板类按钮：点击时立即露出 webview（面板在 webview 内，被 Agent 视图遮挡）
  var NO_REVEAL = { 'tokfree-btn-theme': 1, 'tokfree-btn-change-dir': 1 };
  function rbClickOverlayBtn(overlayBtnId) {
    if (!NO_REVEAL[overlayBtnId]) {
      revealGraceUntil = Date.now() + 2500;
      setWebRevealed(true);
    }
    // 检查按钮是否存在/可用，并给出明确反馈：
    // 页面停在拦截页/未就绪时，webview 内 overlay 未注入 → 按钮不存在 → 用户「点了没反应」。
    var code = '(function(){var el=document.getElementById(' + JSON.stringify(overlayBtnId) + ');' +
      'if(!el)return {ok:false,reason:"no-button"};' +
      'if(el.disabled)return {ok:false,reason:"disabled"};' +
      'el.click();return {ok:true};})()';
    return execInActive(code).then(function (r) {
      if (r && r.ok === false && typeof shellToast === 'function') {
        shellToast(r.reason === 'disabled' ? '按钮暂不可用，请稍候' : '页面尚未就绪（可能未登录或加载中），请稍候或点「查看网页」', 3500);
      }
    }).catch(function () {
      if (typeof shellToast === 'function') shellToast('当前标签不可用，请点「查看网页」检查', 3000);
    });
  }

  var rbSyncing = false;
  // 右栏同步：复用合并轮询的渲染逻辑（同一份 webview 读取结果驱动面板/执行态/右栏）。
  function syncRightBar() {
    var wv = getActiveWebview();
    if (!wv) { applyRightBarFromWeb(null); return; }
    if (rbSyncing) return;
    rbSyncing = true;
    execInActive(buildWebStatusCode())
      .then(function (r) { applyRightBarFromWeb(r); })
      .catch(function () {})
      .then(function () { rbSyncing = false; });
  }

  // ===== 开发者模式（显示被隐藏的思考/工具过程） =====
  var devModeEl = document.getElementById('rb-dev-mode');

  // 打包版本隐藏「开发者模式」开关：临时调试功能，不随发布包提供。
  // 隐藏的同时强制关闭一次，避免打包用户停留在全开状态。
  if (window.shellAPI && window.shellAPI.getShellInfo) {
    window.shellAPI.getShellInfo().then(function (info) {
      if (!info || !info.isPackaged) return;
      var lbl = devModeEl && devModeEl.closest ? devModeEl.closest('.rb-toggle-label') : null;
      if (lbl) lbl.classList.add('rb-hidden');
      if (devModeEl && devModeEl.checked) { devModeEl.checked = false; applyDevMode(); }
    }).catch(function () {});
  }

  function applyDevMode() {
    var on = !!(devModeEl && devModeEl.checked);
    // 隐藏机制靠 <style id="tokfree-hide-tool-style"> + documentElement 属性协同：
    // 开 = 打属性（preload 停止注入/清空样式文本）；关 = 撤属性 + 恢复隐藏样式。
    var code =
      '(function(){' +
      'var de=document.documentElement;' +
      'if(' + on + '){de.setAttribute("data-tokfree-dev","1");}' +
      'else{de.removeAttribute("data-tokfree-dev");}' +
      'var s=document.getElementById("tokfree-hide-tool-style");' +
      'if(' + on + '){if(s)s.textContent="";}' +
      'else{' +
      'if(!s){s=document.createElement("style");s.id="tokfree-hide-tool-style";(document.head||de).appendChild(s);}' +
      's.textContent="[data-tokfree-hide=\\"1\\"]{display:none !important;}";' +
      '}' +
      'return true;' +
      '})()';
    execInActive(code).catch(function () {});
  }
  if (devModeEl) {
    devModeEl.addEventListener('change', applyDevMode);
  }

  // ===== 左侧栏：当前标签的 AI 会话列表 =====
  var sessionListEl = document.getElementById('lb-session-list');
  var sessionSyncing = false;
  var lastSessionAliases = {};
  var sessionFilter = '';   // 会话搜索关键词（客户端过滤当前会话列表）

  // ===== 会话置顶 / 多选（壳层本地持久化，按 profileId 区分）=====
  var multiSelectMode = false;
  var multiSelected = {};
  var sessionMenuEl = null;

  function attrEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }
  function getActiveProfileId() {
    var t = activeId ? findTab(activeId) : null;
    return t ? (t.profileId || '') : '';
  }
  function readArr(key) {
    try { var v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
  }
  function writeArr(key, arr) { try { localStorage.setItem(key, JSON.stringify(arr)); } catch (_) {} }
  function pinKey() { return 'tokfree-session-pin-' + getActiveProfileId(); }
  function hiddenKey() { return 'tokfree-session-hidden-' + getActiveProfileId(); }
  function getPinnedList() { return readArr(pinKey()); }
  function isPinned(sid) { return getPinnedList().indexOf(sid) !== -1; }
  function togglePin(sid) {
    var list = getPinnedList();
    var i = list.indexOf(sid);
    if (i === -1) list.unshift(sid); else list.splice(i, 1);
    writeArr(pinKey(), list);
    renderSessionList(getCurrentSessions(), lastSessionAliases);
  }
  function getHiddenList() { return readArr(hiddenKey()); }
  function hideSessions(ids) {
    var list = getHiddenList();
    for (var i = 0; i < ids.length; i++) { if (list.indexOf(ids[i]) === -1) list.push(ids[i]); }
    writeArr(hiddenKey(), list);
  }

  function findItemBySid(sid) {
    var items = sessionListEl ? sessionListEl.querySelectorAll('.lb-session-item') : [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].getAttribute('data-sid') === sid) return items[i];
    }
    return null;
  }

  function onDocClickCloseMenu(e) {
    if (sessionMenuEl && sessionMenuEl.contains(e.target)) return;
    closeSessionMenu();
  }
  function closeSessionMenu() {
    if (sessionMenuEl && sessionMenuEl.parentNode) sessionMenuEl.parentNode.removeChild(sessionMenuEl);
    sessionMenuEl = null;
    document.removeEventListener('click', onDocClickCloseMenu, true);
  }
  function openSessionMenu(anchorEl, sid) {
    closeSessionMenu();
    var menu = document.createElement('div');
    menu.className = 'lb-session-menu';
    var pinned = isPinned(sid);
    menu.innerHTML =
      '<button class="lb-menu-item" data-act="rename" type="button">重命名</button>' +
      '<button class="lb-menu-item" data-act="pin" type="button">' + (pinned ? '取消置顶' : '置顶') + '</button>' +
      '<button class="lb-menu-item" data-act="export" type="button">导出 Markdown</button>' +
      '<button class="lb-menu-item" data-act="delete" type="button">删除</button>' +
      '<button class="lb-menu-item" data-act="multi" type="button">多选</button>';
    document.body.appendChild(menu);
    var r = anchorEl.getBoundingClientRect();
    var left = Math.max(8, Math.min(r.right - 110, window.innerWidth - 130));
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(r.bottom + 2) + 'px';
    sessionMenuEl = menu;
    menu.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.lb-menu-item') : null;
      if (!btn) return;
      e.stopPropagation();
      var act = btn.getAttribute('data-act');
      closeSessionMenu();
      if (act === 'rename') {
        var item = findItemBySid(sid);
        if (item) startRename(item, sid);
      } else if (act === 'pin') {
        togglePin(sid);
      } else if (act === 'export') {
        exportSessionMd(sid);
      } else if (act === 'delete') {
        if (!window.confirm('确定删除该会话？仅从列表移除，不影响网页端原始会话。')) return;
        hideSessions([sid]);
        syncSessionList();
      } else if (act === 'multi') {
        enterMultiSelect();
      }
    });
    setTimeout(function () { document.addEventListener('click', onDocClickCloseMenu, true); }, 0);
  }

  function updateMultiBar() {
    var bar = document.getElementById('lb-multi-bar');
    if (!bar) return;
    bar.classList.toggle('lb-hidden', !multiSelectMode);
    var cnt = document.getElementById('lb-multi-count');
    var n = 0;
    for (var k in multiSelected) { if (multiSelected[k]) n++; }
    if (cnt) cnt.textContent = '已选 ' + n;
  }
  function enterMultiSelect() {
    multiSelectMode = true;
    multiSelected = {};
    updateMultiBar();
    renderSessionList(getCurrentSessions(), lastSessionAliases);
  }
  function exitMultiSelect() {
    multiSelectMode = false;
    multiSelected = {};
    updateMultiBar();
    renderSessionList(getCurrentSessions(), lastSessionAliases);
  }

  // 设置当前活动会话 ID：更新高亮 + 记住到所属标签，并重绘列表
  function setCurrentSession(sid) {
    curSessionId = sid || null;
    var t = activeId ? findTab(activeId) : null;
    if (t) t.sessionId = curSessionId;
    renderSessionList(getCurrentSessions(), lastSessionAliases);
  }

  function renderSessionList(sessions, aliases) {
    if (!sessionListEl) return;
    if (renamingSid) return; // 重命名进行中：跳过重建，避免销毁正在编辑的 input 触发 blur 自动保存
    lastSessionAliases = aliases || {};
    var hidden = getHiddenList();
    var pinned = getPinnedList();
    var list = (sessions || []).filter(function (id) {
      if (hidden.indexOf(id) !== -1) return false;
      if (!sessionFilter) return true;
      var q = sessionFilter.toLowerCase();
      var alias = (aliases && aliases[id]) || '';
      var meta = lastSessionMeta[id] || {};
      var title = meta.title || '';
      return (String(id).toLowerCase().indexOf(q) !== -1) || (String(alias).toLowerCase().indexOf(q) !== -1) || (String(title).toLowerCase().indexOf(q) !== -1);
    });
    list.sort(function (a, b) {
      var pa = pinned.indexOf(a); if (pa === -1) pa = 999999;
      var pb = pinned.indexOf(b); if (pb === -1) pb = 999999;
      return pa - pb;
    });
    if (list.length === 0) {
      sessionListEl.innerHTML = '<div class="lb-session-empty">' + (sessionFilter ? '无匹配会话' : '暂无会话') + '</div>';
      return;
    }
    sessionListEl.innerHTML = list.map(function (id) {
      var alias = (lastSessionAliases && lastSessionAliases[id]) || '';
      var meta = lastSessionMeta[id] || {};
      var label = alias || meta.title || id;
      var projDir = meta.projectDir || '';
      var projName = projDir ? String(projDir).replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
      var isPin = pinned.indexOf(id) !== -1;
      var isActive = (id === curSessionId);
      var cls = 'lb-session-item' + (isPin ? ' pinned' : '') + (multiSelectMode ? ' multiselect' : '') + (isActive ? ' active' : '');
      var check = multiSelectMode
        ? '<input type="checkbox" class="session-check" data-sid="' + attrEsc(id) + '"' + (multiSelected[id] ? ' checked' : '') + ' />'
        : '';
      var badge = isPin ? '<span class="session-pin-badge" title="已置顶">📌</span>' : '';
      return '<div class="' + cls + '" data-sid="' + attrEsc(id) + '" title="' + attrEsc(id) + '">' +
        check +
        '<span class="session-id' + (alias ? ' aliased' : '') + '">' + label.replace(/</g, '&lt;') + '</span>' +
        (projName ? '<span class="session-proj">' + projName.replace(/</g, '&lt;') + '</span>' : '') +
        badge +
        '<span class="session-more" title="更多操作">⋯</span></div>';
    }).join('');
    var items = sessionListEl.querySelectorAll('.lb-session-item');
    for (var i = 0; i < items.length; i++) {
      (function (item) {
        var sid = item.getAttribute('data-sid');
        var checkEl = item.querySelector('.session-check');
        if (checkEl) {
          checkEl.addEventListener('click', function (e) { e.stopPropagation(); });
          checkEl.addEventListener('change', function () {
            multiSelected[sid] = !!checkEl.checked;
            updateMultiBar();
          });
        }
        // 点击整条：多选模式下切换勾选，否则跳转会话
        item.addEventListener('click', function () {
          if (!sid || item.classList.contains('editing')) return;
          if (multiSelectMode) {
            multiSelected[sid] = !multiSelected[sid];
            var c = item.querySelector('.session-check');
            if (c) c.checked = !!multiSelected[sid];
            updateMultiBar();
            return;
          }
          execInActive('window.electronAPI && window.electronAPI.navigateSession ? window.electronAPI.navigateSession(' + JSON.stringify(sid) + ') : null')
            .catch(function () {});
          // 立即高亮反馈：切换会话后把当前会话 ID 记下并重绘
          setCurrentSession(sid);
        });
        // 双击名称：进入重命名
        var nameEl = item.querySelector('.session-id');
        if (nameEl) {
          nameEl.addEventListener('dblclick', function (e) {
            e.stopPropagation();
            startRename(item, sid);
          });
        }
        // ⋯ 按钮：打开菜单
        var moreBtn = item.querySelector('.session-more');
        if (moreBtn) {
          moreBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            openSessionMenu(moreBtn, sid);
          });
        }
      })(items[i]);
    }
  }

  /** 会话条目内联重命名：Enter 保存 / Esc 取消 / 失焦保存 */
  function startRename(item, sid) {
    if (!item || !sid || item.classList.contains('editing')) return;
    var nameEl = item.querySelector('.session-id');
    if (!nameEl) return;
    item.classList.add('editing');
    renamingSid = sid;
    var oldLabel = nameEl.textContent || '';
    var input = document.createElement('input');
    input.className = 'session-edit-input';
    input.value = (lastSessionAliases && lastSessionAliases[sid]) || '';
    input.placeholder = sid;
    input.maxLength = 60;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    var finished = false;
    function finish(save) {
      if (finished) return;
      finished = true;
      renamingSid = null;
      var alias = input.value.trim();
      if (!save) { renderSessionList(getCurrentSessions(), lastSessionAliases); return; }
      var code = 'window.electronAPI && window.electronAPI.renameSession ? window.electronAPI.renameSession(' +
        JSON.stringify(sid) + ', ' + JSON.stringify(alias) + ') : null';
      execInActive(code)
        .catch(function () {})
        .then(function () {
          sessionSyncing = false;
          syncSessionList();
        });
      // 网页端改名不再在此直接执行：主进程收到 rename-session 后会广播 'session-renamed'，
      // 各 webview preload（含本窗口）收到后各自执行 renameRemoteSession，实现跨窗口同步。
    }
    input.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', function () { finish(true); });
    input.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  // 记住最近一次会话 ID 列表（取消重命名时用于恢复渲染）
  var lastSessionIds = [];
  // 会话元数据 { [id]: { title, projectDir, updatedAt, pinned } }（来自主进程 list-sessions）
  var lastSessionMeta = {};
  // 全量目录抓取的节流时间戳（抓取较重，最多每 60s 一次；list-sessions 仍每 5s 刷新）
  var lastCatalogFetchTs = 0;
  var renamingSid = null;
  function getCurrentSessions() { return lastSessionIds; }

  function syncSessionList() {
    var wv = getActiveWebview();
    if (!wv) { renderSessionList([]); return; }
    if (sessionSyncing) return;
    sessionSyncing = true;
    // 先触发一次全量会话目录抓取（webview preload 世界 fetch 网页端 API 并保存到主进程），失败静默。
    // 抓取较重（可能翻多页），节流：最多每 60s 抓一次；其余轮询只刷新列表。
    var now = Date.now();
    var doFetch = (now - lastCatalogFetchTs) > 60000;
    if (doFetch) lastCatalogFetchTs = now;
    var fetchCode = 'window.electronAPI && window.electronAPI.fetchSessionCatalog ? window.electronAPI.fetchSessionCatalog() : {ok:false,error:"no api"}';
    (doFetch ? execInActive(fetchCode) : Promise.resolve(null))
      .catch(function () {})
      .then(function () {
        // 抓取保存后再拉全量列表（串行）
        return execInActive('window.electronAPI && window.electronAPI.listSessions ? window.electronAPI.listSessions() : {success:true, sessions:[], aliases:{}}');
      })
      .then(function (r) {
        var list = (r && r.success && Array.isArray(r.sessions)) ? r.sessions : [];
        lastSessionIds = list;
        lastSessionMeta = (r && r.sessionsMeta) || {};
        renderSessionList(list, (r && r.aliases) || {});
      })
      .catch(function () {})
      .then(function () { sessionSyncing = false; });
  }

  // ===== 会话搜索框（客户端过滤当前列表；有 projectDir 时优先向主进程检索）=====
  var sessionSearchInput = document.getElementById('lb-session-search-input');
  if (sessionSearchInput) {
    sessionSearchInput.addEventListener('input', function () {
      sessionFilter = (sessionSearchInput.value || '').trim();
      // 优先走主进程 session-search（可覆盖不在当前列表命中的会话）；不可用则本地过滤兜底。
      if (sessionFilter && window.shellAPI && window.shellAPI.sessionSearch) {
        window.shellAPI.sessionSearch(sessionFilter, null, getActiveProfileId() || null).then(function (r) {
          if (r && r.success && Array.isArray(r.results) && r.results.length) {
            var ids = r.results.map(function (x) { return x.sessionId; });
            var aliases = {};
            for (var i = 0; i < r.results.length; i++) {
              if (r.results[i].alias) aliases[r.results[i].sessionId] = r.results[i].alias;
            }
            renderSessionList(ids, aliases);
          } else {
            renderSessionList(getCurrentSessions(), lastSessionAliases);
          }
        }).catch(function () {
          renderSessionList(getCurrentSessions(), lastSessionAliases);
        });
      } else {
        renderSessionList(getCurrentSessions(), lastSessionAliases);
      }
    });
  }

  // 导出会话为 Markdown：消息由 webview 内 extractConversation 采集后回传主进程序列化。
  function exportSessionMd(sid) {
    if (!sid) return;
    shellToast('正在导出会话…', 3000);
    execInActive('window.electronAPI && window.electronAPI.extractConversation ? window.electronAPI.extractConversation() : null')
      .then(function (conv) {
        var messages = (conv && conv.messages) ? conv.messages : [];
        if (!window.shellAPI || !window.shellAPI.sessionExport) {
          shellToast('导出功能不可用');
          return null;
        }
        return window.shellAPI.sessionExport(sid, messages, 'markdown', null);
      })
      .then(function (r) {
        if (!r) return;
        if (r.success) shellToast('已导出：' + (r.path || '下载目录'));
        else shellToast('导出失败：' + (r.error || '未知'));
      })
      .catch(function (e) { shellToast('导出失败：' + ((e && e.message) || e)); });
  }

  var refreshSessionsBtn = document.getElementById('lb-btn-refresh-sessions');
  if (refreshSessionsBtn) {
    refreshSessionsBtn.addEventListener('click', function () {
      sessionSyncing = false;
      syncSessionList();
    });
  }

  // 「＋ 新增会话」：新对话（等价 DeepSeek Ctrl+J，导航到首页）+ 自动触发初始化项目
  var newSessionBtn = document.getElementById('lb-btn-new-session');
  if (newSessionBtn) {
    newSessionBtn.addEventListener('click', function () {
      var wv = getActiveWebview();
      if (wv) { try { wv.loadURL(getTabHomeUrl(activeId ? findTab(activeId) : null)); } catch (_) {} }
      setTimeout(function () { rbClickOverlayBtn('tokfree-btn-init'); }, 3000);
    });
  }

  // 多选工具条：批量删除（本地隐藏，不改动网页端会话）+ 取消
  var multiDelBtn = document.getElementById('lb-multi-del');
  if (multiDelBtn) {
    multiDelBtn.addEventListener('click', function () {
      var ids = [];
      for (var k in multiSelected) { if (multiSelected[k]) ids.push(k); }
      if (!ids.length) return;
      hideSessions(ids);
      exitMultiSelect();
      syncSessionList();
    });
  }
  var multiCancelBtn = document.getElementById('lb-multi-cancel');
  if (multiCancelBtn) {
    multiCancelBtn.addEventListener('click', function () { exitMultiSelect(); });
  }

  // ===== 右侧栏按钮绑定 =====
  function bindRightBar() {
    var map = {
      'rb-btn-change-dir': 'tokfree-btn-change-dir',
      'rb-btn-init': 'tokfree-btn-init',
      'rb-btn-quick-login': 'tokfree-btn-quick-login',
      'rb-btn-gen-doc': 'tokfree-btn-gen-doc',
      'rb-btn-manual-parse': 'tokfree-btn-manual-parse',
      'rb-btn-compact': 'tokfree-btn-compact'
    };
    Object.keys(map).forEach(function (k) {
      var el = document.getElementById(k);
      if (!el) return;
      el.addEventListener('click', function () { rbClickOverlayBtn(map[k]); });
    });

    // 设置按钮：左下角「设置」打开壳层全局设置弹窗（作用于所有标签）
    var lbSettingsBtn = document.getElementById('lb-btn-settings');
    if (lbSettingsBtn) lbSettingsBtn.addEventListener('click', function () { ssmOpen(); });



    // 主题切换：写入主进程单一真源，由 theme-changed 广播统一应用
    var themeBtn = document.getElementById('rb-btn-theme');
    if (themeBtn) {
      themeBtn.addEventListener('click', function () {
        toggleTheme();
      });
    }

    var sendBtn = document.getElementById('rb-btn-user-send');
    var inputEl = document.getElementById('rb-user-input');
    var hintEl = document.getElementById('rb-user-hint');
    function sendUserMsg() {
      if (!inputEl) return;
      var text = inputEl.value.trim();
      if (!text) return;
      var code =
        '(function(){' +
        'var i=document.getElementById("tokfree-user-input");' +
        'var b=document.getElementById("tokfree-user-send");' +
        'if(!i||!b)return {ok:false};' +
        'i.value=' + JSON.stringify(text) + ';' +
        'b.click();return {ok:true};' +
        '})()';
      execInActive(code).then(function (r) {
        if (r && r.ok) {
          inputEl.value = '';
          if (hintEl) hintEl.textContent = '已发送';
        } else if (hintEl) {
          hintEl.textContent = '未找到输入框';
        }
      }).catch(function () { if (hintEl) hintEl.textContent = '发送失败'; });
    }
    if (sendBtn) sendBtn.addEventListener('click', sendUserMsg);
    if (inputEl) inputEl.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendUserMsg(); }
    });

    // 多 Agent 模式开关：转发到 webview 内 overlay 的原生 checkbox
    var teamToggle = document.getElementById('rb-team-mode');
    if (teamToggle) {
      teamToggle.addEventListener('change', function () {
        var want = !!teamToggle.checked;
        var code =
          '(function(){' +
          'var t=document.getElementById("tokfree-team-mode-toggle");' +
          'if(!t)return {ok:false};' +
          't.checked=' + (want ? 'true' : 'false') + ';' +
          't.dispatchEvent(new Event("change",{bubbles:true}));' +
          'return {ok:true};' +
          '})()';
        execInActive(code).catch(function () {});
      });
    }
  }

  bindRightBar();
  initRbUsageUI();

  // ===== 自动压缩上下文（壳层右栏监控区）=====
  // 配置持久化到壳层 localStorage；阈值单位「万 token」（默认 80 → 800000）。
  var SHELL_AUTO_COMPACT_KEY = 'tokfree-shell-auto-compact-enabled';
  var SHELL_AUTO_COMPACT_THRESHOLD_KEY = 'tokfree-shell-auto-compact-threshold';
  var AUTO_COMPACT_COOLDOWN_MS = 60000;
  var autoCompactCooldownUntil = 0;

  function readAutoCompactEnabled() {
    try { return localStorage.getItem(SHELL_AUTO_COMPACT_KEY) === '1'; } catch (e) { return false; }
  }
  function readAutoCompactThresholdWan() {
    try {
      var v = parseFloat(localStorage.getItem(SHELL_AUTO_COMPACT_THRESHOLD_KEY));
      if (isFinite(v) && v > 0) return v;
    } catch (e) {}
    return 80;
  }
  function parseTokenCount(text) {
    // 支持中文单位：如 "75.24万" → 752400，"80万" → 800000，"1.2k" → 1200。
    // 无单位（如 "752400"）时返回原值。非法输入返回 NaN。
    try {
      var s = String(text == null ? '' : text).trim();
      if (!s) return NaN;
      var m = s.match(/([0-9]+(?:\.[0-9]+)?)\s*(亿|万|k|K|w)?/);
      if (!m) return NaN;
      var n = parseFloat(m[1]);
      if (!isFinite(n)) return NaN;
      var unit = m[2];
      if (unit === '亿') n = n * 100000000;
      else if (unit === '万' || unit === 'w') n = n * 10000;
      else if (unit === 'k' || unit === 'K') n = n * 1000;
      return n;
    } catch (e) { return NaN; }
  }
  // 在活动 webview 内点击「压缩上下文」按钮（不露出 webview）
  function execCompactInWeb() {
    return execInActive('var b=document.getElementById("tokfree-btn-compact"); if(b)b.click(); true')
      .catch(function () {});
  }
  // 需求B2/B3：把壳层自动压缩开关/阈值写入活动 webview 的 localStorage，保证 webview 内 checkAutoCompact 读到一致值
  function pushAutoCompactToWebview() {
    var en = readAutoCompactEnabled() ? '1' : '0';
    var th = String(readAutoCompactThresholdWan());
    var code = 'try{localStorage.setItem("tokfree-auto-compact-enabled","' + en + '");' +
      'localStorage.setItem("tokfree-auto-compact-threshold","' + th + '");' +
      'if(typeof loadAutoCompactConfig==="function")loadAutoCompactConfig();}catch(e){} true';
    execInActive(code).catch(function () {});
  }
  // token 达到阈值时自动触发压缩（勾选开启 + 未在冷却中）
  function maybeAutoCompact(tokenText) {
    if (Date.now() < autoCompactCooldownUntil) return;
    if (!readAutoCompactEnabled()) return;
    var n = parseTokenCount(tokenText);
    if (!isFinite(n)) return;
    var threshold = readAutoCompactThresholdWan() * 10000;
    if (n < threshold) return;
    autoCompactCooldownUntil = Date.now() + AUTO_COMPACT_COOLDOWN_MS;
    execCompactInWeb();
  }
  // 初始化监控区 UI（回填配置 + 绑定持久化）
  (function initAutoCompactUI() {
    var enabledEl = document.getElementById('rb-auto-compact-enabled');
    var thrEl = document.getElementById('rb-auto-compact-threshold');
    if (enabledEl) {
      enabledEl.checked = readAutoCompactEnabled();
      enabledEl.addEventListener('change', function () {
        try { localStorage.setItem(SHELL_AUTO_COMPACT_KEY, enabledEl.checked ? '1' : '0'); } catch (e) {}
        pushAutoCompactToWebview();
      });
    }
    if (thrEl) {
      thrEl.value = String(readAutoCompactThresholdWan());
      thrEl.addEventListener('change', function () {
        var v = parseFloat(thrEl.value);
        if (!isFinite(v) || v <= 0) v = 80;
        thrEl.value = String(v);
        try { localStorage.setItem(SHELL_AUTO_COMPACT_THRESHOLD_KEY, String(v)); } catch (e) {}
        pushAutoCompactToWebview();
      });
    }
    // 启动时主动推一次当前配置，保证初始一致
    pushAutoCompactToWebview();
  })();

  // ===== 全局「窗口管理」浮层（壳层级，跨标签共享）=====
  // 右侧栏「窗口管理」按钮直接在壳层打开该浮层，不再转发到当前 webview 的 overlay。
  // 因为它是壳层 DOM（不在任何 webview 内），切换标签不会消失；列表展示所有窗口（跨标签）。
  var SWM_TONE_CLASS = { idle: 'swm-tone-idle', busy: 'swm-tone-busy', warn: 'swm-tone-warn', banned: 'swm-tone-banned' };

  function swmEl(id) { return document.getElementById(id); }

  var swmRefreshTimer = null;

  function openShellWindowManager() {
    var mask = swmEl('swm-mask');
    if (!mask) return;
    mask.classList.remove('swm-hidden');
    renderShellWatchdogPanel();
    renderShellWindowList();
    // 面板打开时 1.5s 定时刷新（幂等：已有定时器则不叠加）
    if (swmRefreshTimer === null) {
      swmRefreshTimer = setInterval(renderShellWindowList, 1500);
    }
  }

  function closeShellWindowManager() {
    var mask = swmEl('swm-mask');
    if (mask) mask.classList.add('swm-hidden');
    // 面板关闭时清除定时刷新，避免后台高频轮询
    if (swmRefreshTimer !== null) {
      clearInterval(swmRefreshTimer);
      swmRefreshTimer = null;
    }
  }

  function isShellWindowManagerOpen() {
    var mask = swmEl('swm-mask');
    return !!(mask && !mask.classList.contains('swm-hidden'));
  }

  // ===== 平台选择浮层（点 + 新建标签时弹出，风格对齐窗口管理浮层）=====
  function openPlatformSelect() {
    var mask = document.getElementById('psm-mask');
    if (!mask) return;
    var list = document.getElementById('psm-list');
    if (list) list.innerHTML = '加载中…';
    var api = window.shellAPI || window.electronAPI;
    var p = (api && api.listProviders) ? api.listProviders() : Promise.resolve(null);
    Promise.resolve(p).then(function (res) {
      var providers = res && res.providers ? res.providers : (res || []);
      if (!Array.isArray(providers)) providers = [];
      if (!list) return;
      if (!providers.length) { list.innerHTML = '暂无可用平台'; return; }
      list.innerHTML = '';
      providers.forEach(function (prov) {
        var id = prov.id;
        var card = document.createElement('div');
        card.className = 'psm-card';
        card.setAttribute('data-id', id);
        var logo = document.createElement('div');
        logo.className = 'psm-card-logo';
        var img = document.createElement('img');
        img.src = 'logos/' + encodeURIComponent(id) + '.svg';
        img.alt = prov.name || id;
        img.onerror = function () {
          var fb = document.createElement('span');
          fb.className = 'fb';
          fb.textContent = String(id || '?').charAt(0).toUpperCase();
          logo.innerHTML = '';
          logo.appendChild(fb);
        };
        logo.appendChild(img);
        var name = document.createElement('div');
        name.className = 'psm-card-name';
        name.textContent = prov.name || id;
        card.appendChild(logo);
        card.appendChild(name);
        card.addEventListener('click', function () {
          var pid = card.getAttribute('data-id');
          closePlatformSelect();
          var a = window.shellAPI || window.electronAPI;
          if (a && a.createProfileWindowWithProvider) a.createProfileWindowWithProvider(pid);
          else if (a && a.createProfileWindow) a.createProfileWindow();
        });
        list.appendChild(card);
      });
      mask.classList.remove('swm-hidden');
    }).catch(function () {
      if (list) list.innerHTML = '加载失败';
      mask.classList.remove('swm-hidden');
    });
  }

  function closePlatformSelect() {
    var mask = document.getElementById('psm-mask');
    if (mask) mask.classList.add('swm-hidden');
  }

  function swmEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 账号状态文案/配色（与原版 overlay 一致）
  var SWM_ACCT_COLOR = { active: 'var(--text-2)', limited: '#d5a021', expired: 'var(--warn)', disabled: 'var(--text-3)' };
  var SWM_ACCT_TEXT = { active: '正常', limited: '限流', expired: '过期', disabled: '停用' };

  // 渲染窗口列表：合并 list-profiles（全量 profile）与 list-windows-status（各窗口 AI 状态）
  function renderShellWindowList() {
    var list = swmEl('swm-list');
    if (!list) return;
    if (!window.shellAPI || !window.shellAPI.listProfiles) {
      list.innerHTML = '<div class="swm-empty">当前环境不支持窗口列表</div>';
      return;
    }
    list.innerHTML = '<div class="swm-empty">加载中…</div>';
    var profilesP = window.shellAPI.listProfiles().catch(function () { return null; });
    var statusP = (window.shellAPI.listWindowsStatus ? window.shellAPI.listWindowsStatus() : Promise.resolve(null))
      .catch(function () { return null; });
    var providerP = (window.shellAPI.listProviders ? window.shellAPI.listProviders() : Promise.resolve(null))
      .catch(function () { return null; });

    Promise.all([profilesP, statusP, providerP]).then(function (arr) {
      var pres = arr[0], sres = arr[1], pvres = arr[2];
      var profiles = (pres && pres.success && pres.profiles) ? pres.profiles : [];
      var statusList = (sres && sres.success && sres.windows) ? sres.windows : [];
      var providerMap = {};
      if (pvres && pvres.success && pvres.providers) {
        pvres.providers.forEach(function (p) { providerMap[p.id] = p.name; });
      }
      var statusMap = {};
      statusList.forEach(function (w) { statusMap[w.profileId] = w; });

      renderShellOverview(profiles, statusMap);
      renderShellStatsPanel();
      // renderShellTokenPanel(); // 旧窗口管理 token 面板已移除（改用右栏「使用统计」）
      renderShellDashboard();
      renderShellStatsEvents();
      startShellWmBanTick();

      if (!profiles.length) {
        list.innerHTML = '<div class="swm-empty">暂无窗口</div>';
        return;
      }
      var activeProfileId = '';
      var at = activeId ? findTab(activeId) : null;
      if (at) activeProfileId = at.profileId || '';

      var html = profiles.map(function (p) {
        var st = statusMap[p.id] || null;
        var label = st ? st.label : '未打开';
        var tone = (st && st.state) || 'idle';
        var toneCls = SWM_TONE_CLASS[tone] || 'swm-tone-idle';
        var pname = providerMap[p.providerId] || '未选平台';
        // 角色 badge
        var roleBadge = '';
        if (st && st.role === 'master') {
          roleBadge = '<span class="swm-badge swm-badge-master" title="主大脑">主</span>';
        } else if (st && st.role === 'worker') {
          var bname = st.belongTo || '';
          if (bname) {
            var bm = null;
            for (var i = 0; i < profiles.length; i++) { if (profiles[i].id === bname) { bm = profiles[i]; break; } }
            bname = bm ? bm.name : bname;
          }
          roleBadge = '<span class="swm-badge swm-badge-worker" title="子 Agent' + (bname ? '（属 ' + swmEsc(bname) + '）' : '') + '">次' + (bname ? '·' + swmEsc(bname.slice(0, 4)) : '') + '</span>';
        }
        // 账号标签
        var acctHtml = '';
        var acct = p.account;
        if (acct && (acct.label || acct.group || (acct.status && acct.status !== 'active'))) {
          var parts = [];
          if (acct.label) parts.push(acct.label);
          if (acct.group) parts.push('[' + acct.group + ']');
          parts.push(SWM_ACCT_TEXT[acct.status] || '正常');
          acctHtml = '<span class="swm-item-acct" style="color:' + (SWM_ACCT_COLOR[acct.status] || 'var(--text-2)') + '">' + swmEsc(parts.join(' ')) + '</span>';
        }
        var isActive = (p.id === activeProfileId);
        var sub = pname + (acctHtml ? ' · ' + acctHtml : '');
        if (st && st.currentTask) sub += ' · 任务：' + swmEsc(st.currentTask.module || st.currentTask.taskId || '');
        // 禁言倒计时记录
        var banAttr = (tone === 'banned' && st && st.banRemainSec) ? ' data-ban-remain="' + st.banRemainSec + '"' : '';
        return '<div class="swm-item' + (isActive ? ' swm-item-active' : '') + '" data-profile-id="' + swmEsc(p.id) + '">' +
          '<div class="swm-item-main">' +
            '<div class="swm-item-top">' +
              '<span class="swm-item-name">' + swmEsc(p.name || '未命名窗口') + '</span>' +
              roleBadge +
            '</div>' +
            '<div class="swm-item-sub">' + sub + '</div>' +
          '</div>' +
          '<span class="swm-item-state ' + toneCls + '"' + banAttr + '><span class="swm-dot">●</span>' + swmEsc(label) + '</span>' +
          '<span class="swm-item-actions">' +
            '<button class="swm-mini swm-act-cfg" data-profile-id="' + swmEsc(p.id) + '" title="窗口设置">⚙</button>' +
            '<button class="swm-mini swm-act-role" data-profile-id="' + swmEsc(p.id) + '" title="改角色">角色</button>' +
            '<button class="swm-mini swm-act-del" data-profile-id="' + swmEsc(p.id) + '" title="删除窗口">删除</button>' +
          '</span>' +
        '</div>';
      }).join('');
      list.innerHTML = html;

      // 点击项本身 → 切换/聚焦标签
      list.querySelectorAll('.swm-item').forEach(function (el) {
        el.addEventListener('click', function (e) {
          if (e.target && e.target.closest && e.target.closest('.swm-item-actions')) return;
          var profileId = el.getAttribute('data-profile-id');
          if (!profileId) return;
          openShellProfile(profileId);
        });
      });
      // 窗口设置
      list.querySelectorAll('.swm-act-cfg').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          openShellProfileConfig(btn.getAttribute('data-profile-id'));
        });
      });
      // 改角色
      list.querySelectorAll('.swm-act-role').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          openShellRoleMenu(btn, btn.getAttribute('data-profile-id'), profiles);
        });
      });
      // 删除
      list.querySelectorAll('.swm-act-del').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var pid = btn.getAttribute('data-profile-id');
          if (!window.shellAPI || !window.shellAPI.swmDeleteProfileWindow) return;
          if (!window.confirm('确定删除该窗口？')) return;
          window.shellAPI.swmDeleteProfileWindow(pid).then(function (r) {
            if (r && r.success) renderShellWindowList();
            else window.alert((r && r.error) || '删除失败');
          }).catch(function () {});
        });
      });
    }).catch(function (e) {
      list.innerHTML = '<div class="swm-empty">加载失败：' + swmEsc(e && e.message) + '</div>';
    });
  }

  // 当前壳层激活标签的 profileId（看门狗/统计按此定位）
  function shellActiveProfileId() {
    var at = activeId ? findTab(activeId) : null;
    return at ? (at.profileId || '') : '';
  }

  // ---- 看门狗面板 ----
  function renderShellWatchdogPanel() {
    var stateEl = swmEl('swm-wd-state');
    var toggleBtn = swmEl('swm-wd-toggle');
    if (!stateEl || !toggleBtn) return;
    var api = window.shellAPI;
    if (!api || !api.swmWatchdogGetConfig) { stateEl.textContent = '不可用'; return; }
    var pid = shellActiveProfileId();
    var statusP = (api.swmWatchdogStatus ? api.swmWatchdogStatus(pid) : Promise.resolve(null)).catch(function () { return null; });
    var cfgP = api.swmWatchdogGetConfig().catch(function () { return null; });
    Promise.all([statusP, cfgP]).then(function (arr) {
      var st = arr[0] && arr[0].success ? arr[0].status : null;
      var cfg = (st && st.config) || (arr[1] && arr[1].config) || null;
      if (!cfg) { stateEl.textContent = '不可用'; return; }
      var label = '运行中';
      var cls = 'swm-wd-ok';
      if (!cfg.enabled) { label = '已禁用'; cls = 'swm-wd-off'; }
      else if (cfg.paused) { label = '已暂停'; cls = 'swm-wd-paused'; }
      var p = (st && st.profile) || {};
      var extra = '';
      if (p.busy) extra = ' · 长任务中';
      else if (p.cooldownRemain > 0) extra = ' · 冷却' + p.cooldownRemain + 's';
      stateEl.textContent = label + extra;
      stateEl.className = 'swm-wd-state ' + cls;
      toggleBtn.textContent = cfg.paused ? '恢复' : '暂停';
    }).catch(function () { stateEl.textContent = '读取失败'; });
  }

  // ---- 窗口状态概览（各状态计数卡片）----
  function renderShellOverview(profiles, statusMap) {
    var el = swmEl('swm-overview');
    if (!el) return;
    var total = profiles.length;
    var open = 0, busy = 0, idle = 0, warn = 0;
    profiles.forEach(function (p) {
      var st = statusMap[p.id];
      if (!st || !st.open) return;
      open++;
      var tone = st.state || 'idle';
      if (tone === 'busy') busy++;
      else if (tone === 'warn' || tone === 'banned') warn++;
      else idle++;
    });
    function card(label, val, cls) {
      return '<div class="swm-ov-card ' + (cls || '') + '"><span class="swm-ov-num">' + val + '</span><span class="swm-ov-label">' + label + '</span></div>';
    }
    el.innerHTML =
      card('总窗口', total, '') +
      card('已打开', open, '') +
      card('执行中', busy, 'swm-ov-busy') +
      card('空闲', idle, 'swm-ov-idle') +
      card('需注意', warn, 'swm-ov-warn');
  }

  // ---- 运行统计 ----
  var SWM_STATS_WEEKDAYS = null;
  function swmDateKey(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }
  function swmTimeKey(ts) {
    var d = new Date(ts);
    function p(n) { return String(n).padStart(2, '0'); }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function renderShellStatsPanel() {
    var summaryEl = swmEl('swm-stats-summary');
    var listEl = swmEl('swm-stats-list');
    if (!summaryEl || !listEl) return;
    var api = window.shellAPI;
    if (!api || !api.swmGetEventStats) {
      summaryEl.textContent = '不可用';
      listEl.innerHTML = '<div class="swm-empty">暂无数据</div>';
      return;
    }
    var statsP = api.swmGetEventStats().catch(function () { return null; });
    var profilesP = api.listProfiles().catch(function () { return null; });
    var providersP = (api.listProviders ? api.listProviders() : Promise.resolve(null)).catch(function () { return null; });
    Promise.all([statsP, profilesP, providersP]).then(function (arr) {
      var sres = arr[0], pres = arr[1], pvres = arr[2];
      var daily = (sres && sres.success && sres.daily) || {};
      var summary = (sres && sres.success && sres.summary) || {};
      summaryEl.textContent = '今日 催促' + (summary.nag || 0) +
        ' · 拦截' + (summary.intercept || 0) +
        ' · 派发' + (summary.dispatch || 0) +
        ' · 完成' + (summary.done || 0);
      var providerMap = {};
      if (pvres && pvres.success && pvres.providers) {
        pvres.providers.forEach(function (pv) { providerMap[pv.id] = pv.name; });
      }
      var profiles = (pres && pres.success && pres.profiles) ? pres.profiles : [];
      var today = swmDateKey(new Date());
      var rows = [];
      profiles.forEach(function (p) {
        var stat = (daily[p.id] && daily[p.id][today]) || {};
        if (!stat || Object.keys(stat).length === 0) return;
        var win = p.name || providerMap[p.providerId] || p.id;
        rows.push({ win: win, nag: stat.nag || 0, intercept: stat.intercept || 0, sent: stat.sent || 0, received: stat.received || 0 });
      });
      if (rows.length === 0) {
        listEl.innerHTML = '<div class="swm-empty">暂无数据</div>';
        return;
      }
      listEl.innerHTML = rows.map(function (r) {
        return '<div class="swm-stats-row">' +
          '<span class="swm-stats-win" title="' + swmEsc(r.win) + '">' + swmEsc(r.win) + '</span>' +
          '<span class="swm-stats-nums">催促' + r.nag + ' · 拦截' + r.intercept + ' · 收' + r.received + '/发' + r.sent + '</span>' +
        '</div>';
      }).join('');
    }).catch(function () {
      summaryEl.textContent = '读取失败';
      listEl.innerHTML = '<div class="swm-empty">加载失败</div>';
    });
  }

  // ---- Token 用量（今日/本周/总计 + 最近 7 天纯 CSS 柱状图）----
  function swmFormatToken(n) {
    n = Number(n) || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(2) + '亿';
    if (n >= 10000) return (n / 10000).toFixed(2) + '万';
    return String(n);
  }
  function renderShellTokenPanel() {
    var summaryEl = swmEl('swm-token-summary');
    var chartEl = swmEl('swm-token-chart');
    if (!summaryEl || !chartEl) return;
    var api = window.shellAPI;
    if (!api || !api.getTokenStats) {
      summaryEl.textContent = '不可用';
      chartEl.innerHTML = '';
      return;
    }
    api.getTokenStats(7).then(function (res) {
      var data = (res && res.success && res.data) || null;
      if (!data) { summaryEl.textContent = '读取失败'; chartEl.innerHTML = ''; return; }
      summaryEl.textContent = '今日 ' + swmFormatToken(data.today) +
        ' · 本周 ' + swmFormatToken(data.week) +
        ' · 总计 ' + swmFormatToken(data.total);
      var daily = data.daily || [];
      if (!daily.length) { chartEl.innerHTML = '<div class="swm-empty">暂无数据</div>'; return; }
      var max = 0;
      daily.forEach(function (d) { if (d.tokens > max) max = d.tokens; });
      if (max <= 0) { chartEl.innerHTML = '<div class="swm-empty">暂无 Token 记录</div>'; return; }
      chartEl.innerHTML = daily.map(function (d) {
        var ratio = d.tokens / max;
        var pct = Math.max(2, Math.round(ratio * 100));
        var label = d.date.slice(5); // MM-DD
        return '<div class="swm-token-bar-wrap" title="' + swmEsc(d.date) + '：' + swmFormatToken(d.tokens) + '">' +
          '<div class="swm-token-bar-val">' + (d.tokens > 0 ? swmFormatToken(d.tokens) : '') + '</div>' +
          '<div class="swm-token-bar-track"><div class="swm-token-bar" style="height:' + pct + '%"></div></div>' +
          '<div class="swm-token-bar-label">' + swmEsc(label) + '</div>' +
        '</div>';
      }).join('');
    }).catch(function () {
      summaryEl.textContent = '读取失败';
      chartEl.innerHTML = '';
    });
  }

  // ---- 数据看板（Metrics Dashboard）----
  // 借鉴 Mastra observability dashboard：KPI 卡片 + token 趋势 + 各窗口对比表。
  // 数据来自 metrics-store（按 profileId+date 聚合），不含成本估算。
  function swmDateNDaysAgo(n) {
    var d = new Date();
    d.setDate(d.getDate() - n);
    return swmDateKey(d);
  }
  function swmDbToken(n) {
    n = Number(n) || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(2) + '亿';
    if (n >= 10000) return (n / 10000).toFixed(2) + '万';
    return String(n);
  }
  // 纯 Canvas 柱状图（无外部库）；devicePixelRatio 缩放避免模糊
  function swmDrawDbChart(canvas, series) {
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var cssW = canvas.clientWidth || 360;
    var cssH = 120;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    var arr = Array.isArray(series) ? series : [];
    if (!arr.length) {
      ctx.fillStyle = 'rgba(128,128,128,0.6)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('暂无 Token 数据', cssW / 2, cssH / 2);
      return;
    }
    var padTop = 16, padBottom = 16, padX = 6;
    var chartH = cssH - padTop - padBottom;
    var max = 0;
    arr.forEach(function (d) { var v = (d.tokensIn || 0) + (d.tokensOut || 0); if (v > max) max = v; });
    if (max <= 0) {
      ctx.fillStyle = 'rgba(128,128,128,0.6)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('暂无 Token 数据', cssW / 2, cssH / 2);
      return;
    }
    var n = arr.length;
    var slot = (cssW - padX * 2) / n;
    var barW = Math.min(slot * 0.6, 28);
    var accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim() || '#7c6cff';
    arr.forEach(function (d, i) {
      var v = (d.tokensIn || 0) + (d.tokensOut || 0);
      var h = Math.max(v > 0 ? 2 : 0, Math.round((v / max) * chartH));
      var x = padX + slot * i + (slot - barW) / 2;
      var y = padTop + (chartH - h);
      ctx.fillStyle = accent;
      ctx.fillRect(x, y, barW, h);
      // 值标签（仅非零时显示）
      if (v > 0) {
        ctx.fillStyle = 'rgba(128,128,128,0.9)';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(swmDbToken(v), x + barW / 2, y - 3);
      }
      // x 轴日期（MM-DD）
      ctx.fillStyle = 'rgba(128,128,128,0.8)';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      var label = String(d.date || '').slice(5);
      ctx.fillText(label, x + barW / 2, cssH - 4);
    });
  }
  function renderShellDashboard() {
    var kpiEl = swmEl('swm-db-kpi');
    var chartEl = swmEl('swm-db-chart');
    var tableEl = swmEl('swm-db-table');
    if (!kpiEl || !tableEl) return;
    var api = window.shellAPI;
    if (!api || !api.metricsSummary || !api.metricsRange) {
      kpiEl.innerHTML = '<div class="swm-empty">数据看板不可用</div>';
      tableEl.innerHTML = '<div class="swm-empty">暂无数据</div>';
      return;
    }
    // 汇总（所有窗口）：今日 token / 本周任务数 / 完成率
    var summaryP = api.metricsSummary('').catch(function () { return null; });
    // 近 7 天趋势（所有窗口）
    var rangeP = api.metricsRange('', swmDateNDaysAgo(6), swmDateNDaysAgo(0)).catch(function () { return null; });
    // 各窗口明细：先拿 profile 列表，再逐窗口取今日数据
    var profilesP = (api.listProfiles ? api.listProfiles() : Promise.resolve(null)).catch(function () { return null; });

    Promise.all([summaryP, rangeP, profilesP]).then(function (arr) {
      var sres = arr[0], rres = arr[1], pres = arr[2];
      // ---- KPI ----
      var data = (sres && sres.success && sres.data) || null;
      if (!data) {
        kpiEl.innerHTML = '<div class="swm-empty">暂无数据</div>';
      } else {
        var today = data.today || {};
        var week = data.week || {};
        var todayTok = (today.tokensIn || 0) + (today.tokensOut || 0);
        var weekTasks = (week.tasks || 0);
        var weekSuccess = (week.success || 0);
        var weekFail = (week.fail || 0);
        var done = weekSuccess + weekFail;
        var rate = done > 0 ? Math.round((weekSuccess / done) * 100) + '%' : '—';
        function kpi(label, val) {
          return '<div class="swm-db-kpi-card"><span class="swm-db-kpi-num">' + swmEsc(val) + '</span><span class="swm-db-kpi-label">' + swmEsc(label) + '</span></div>';
        }
        kpiEl.innerHTML =
          kpi('今日 Token', swmDbToken(todayTok)) +
          kpi('本周任务数', String(weekTasks)) +
          kpi('本周完成率', rate);
      }
      // ---- 趋势图 ----
      var series = (rres && rres.success && rres.data) || [];
      swmDrawDbChart(chartEl, series);
      // ---- 各窗口对比表 ----
      var profiles = (pres && pres.success && pres.profiles) ? pres.profiles : [];
      if (!api.metricsDaily || !profiles.length) {
        tableEl.innerHTML = '<div class="swm-empty">暂无窗口数据</div>';
        return;
      }
      var todayKey = swmDateNDaysAgo(0);
      var dailyPs = profiles.map(function (p) {
        return api.metricsDaily(p.id, todayKey).then(function (r) {
          var d = (r && r.success && r.data) || {};
          return { name: p.name || p.id, tokens: (d.tokensIn || 0) + (d.tokensOut || 0), tasks: d.tasks || 0 };
        }).catch(function () { return { name: p.name || p.id, tokens: 0, tasks: 0 }; });
      });
      Promise.all(dailyPs).then(function (rows) {
        rows = rows.filter(function (r) { return r.tokens > 0 || r.tasks > 0; })
          .sort(function (a, b) { return b.tokens - a.tokens; });
        if (!rows.length) { tableEl.innerHTML = '<div class="swm-empty">今日暂无用量</div>'; return; }
        var maxTok = rows[0].tokens || 1;
        tableEl.innerHTML = rows.map(function (r) {
          var pct = Math.max(2, Math.round((r.tokens / maxTok) * 100));
          return '<div class="swm-db-row">' +
            '<span class="swm-db-row-name" title="' + swmEsc(r.name) + '">' + swmEsc(r.name) + '</span>' +
            '<span class="swm-db-row-bar"><span class="swm-db-row-fill" style="width:' + pct + '%"></span></span>' +
            '<span class="swm-db-row-tok">' + swmEsc(swmDbToken(r.tokens)) + '</span>' +
          '</div>';
        }).join('');
      }).catch(function () { tableEl.innerHTML = '<div class="swm-empty">加载失败</div>'; });
    }).catch(function () {
      kpiEl.innerHTML = '<div class="swm-empty">加载失败</div>';
      tableEl.innerHTML = '<div class="swm-empty">加载失败</div>';
    });
  }

  // ===== 右栏「使用统计」面板：KPI + 热力图 + 折线 + 饼图 =====
  var RB_USAGE_RANGE = 7;
  var RB_USAGE_MODE = 'cumulative';

  function rbFmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(2) + '亿';
    if (n >= 10000) return (n / 10000).toFixed(2) + '万';
    return String(n);
  }
  function rbFmtDuration(ms) {
    ms = Number(ms) || 0;
    if (ms <= 0) return '—';
    var min = Math.floor(ms / 60000);
    if (min < 60) return min + '分';
    var h = Math.floor(min / 60);
    var m = min % 60;
    return h + '时' + m + '分';
  }
  function rbHeatClass(tokens, max) {
    if (!tokens || tokens <= 0) return 'lv0';
    if (!max || max <= 0) return 'lv1';
    var r = tokens / max;
    if (r > 0.75) return 'lv4';
    if (r > 0.5) return 'lv3';
    if (r > 0.25) return 'lv2';
    return 'lv1';
  }
  // 折线图（纯 Canvas，无外部库）
  function rbDrawTrend(canvas, series) {
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var cssW = canvas.clientWidth || 300;
    var cssH = 96;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    var arr = Array.isArray(series) ? series : [];
    var padTop = 14, padBottom = 16, padX = 6;
    var chartH = cssH - padTop - padBottom;
    var max = 0;
    arr.forEach(function (d) { if ((d.tokens || 0) > max) max = d.tokens; });
    if (!arr.length || max <= 0) {
      ctx.fillStyle = 'rgba(128,128,128,0.6)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('暂无 Token 数据', cssW / 2, cssH / 2);
      return;
    }
    var accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim() || '#4d6bfe';
    var n = arr.length;
    var stepX = n > 1 ? (cssW - padX * 2) / (n - 1) : 0;
    var pts = arr.map(function (d, i) {
      var x = padX + stepX * i;
      var y = padTop + chartH - Math.round(((d.tokens || 0) / max) * chartH);
      return { x: x, y: y };
    });
    ctx.beginPath();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    pts.forEach(function (p, i) { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
    ctx.stroke();
    ctx.lineTo(pts[pts.length - 1].x, padTop + chartH);
    ctx.lineTo(pts[0].x, padTop + chartH);
    ctx.closePath();
    ctx.fillStyle = accent + '22';
    ctx.fill();
    ctx.fillStyle = accent;
    pts.forEach(function (p) { ctx.beginPath(); ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2); ctx.fill(); });
    ctx.fillStyle = 'rgba(128,128,128,0.8)';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    var labelStep = Math.max(1, Math.ceil(n / 7));
    arr.forEach(function (d, i) {
      if (i % labelStep !== 0 && i !== n - 1) return;
      var label = String(d.date || '').slice(5);
      ctx.fillText(label, pts[i].x, cssH - 4);
    });
  }
  function renderRbUsage() {
    var api = window.shellAPI;
    var kpiEl = document.getElementById('rb-usage-kpi');
    if (!kpiEl) return;
    if (!api || !api.shellUsageStats) {
      kpiEl.innerHTML = '<div class="rb-usage-empty">使用统计不可用</div>';
      return;
    }
    var p = api.shellUsageStats({ mode: RB_USAGE_MODE, rangeDays: RB_USAGE_RANGE });
    Promise.resolve(p).then(function (res) {
      var data = (res && res.success && res.data) ? res.data : null;
      if (!data) { kpiEl.innerHTML = '<div class="rb-usage-empty">暂无数据</div>'; return; }
      var kpi = data.kpi || {};
      var cards = [
        ['累计 Token', rbFmtTokens(kpi.totalTokens)],
        ['单日峰值', rbFmtTokens(kpi.peakTokens)],
        ['最长对话', rbFmtDuration(kpi.longestChatMs)],
        ['连续天数', (kpi.currentStreak || 0) + '天'],
      ];
      kpiEl.innerHTML = cards.map(function (c) {
        return '<div class="rb-usage-kpi-card"><span class="rb-usage-kpi-num">' + swmEsc(c[1]) +
          '</span><span class="rb-usage-kpi-label">' + swmEsc(c[0]) + '</span></div>';
      }).join('');
      // 热力图
      var hm = document.getElementById('rb-usage-heatmap');
      var ax = document.getElementById('rb-usage-heatmap-axis');
      var act = Array.isArray(data.activity) ? data.activity : [];
      var maxA = 0;
      act.forEach(function (d) { if ((d.tokens || 0) > maxA) maxA = d.tokens; });
      if (hm) {
        hm.innerHTML = act.map(function (d) {
          return '<span class="rb-usage-cell ' + rbHeatClass(d.tokens, maxA) + '" title="' +
            swmEsc(d.label) + ' · ' + swmEsc(rbFmtTokens(d.tokens)) + '"></span>';
        }).join('');
      }
      if (ax) {
        ax.innerHTML = act.map(function (d) {
          var lb = String(d.label || '');
          if (RB_USAGE_MODE === 'daily') lb = lb.slice(5);
          return '<span class="rb-usage-axis-cell">' + swmEsc(lb) + '</span>';
        }).join('');
      }
      // 折线图
      var trendWrap = document.getElementById('rb-usage-trend');
      if (trendWrap) {
        var cvs = trendWrap.querySelector('canvas');
        if (!cvs) {
          trendWrap.innerHTML = '<canvas class="rb-usage-trend-canvas"></canvas>';
          cvs = trendWrap.querySelector('canvas');
        }
        rbDrawTrend(cvs, data.trend);
      }
      // 饼图（conic-gradient 甜甜圈 + 图例）
      var donut = document.getElementById('rb-usage-donut');
      var bw = Array.isArray(data.byWindow) ? data.byWindow : [];
      if (donut) {
        if (!bw.length) {
          donut.innerHTML = '<div class="rb-usage-empty">暂无窗口用量</div>';
        } else {
          var colors = ['#4d6bfe', '#22a06b', '#e8a33d', '#d54941', '#9b6bdf', '#3aa8c1', '#e06c9f'];
          var acc = 0;
          var stops = [];
          bw.forEach(function (w, i) {
            var start = acc;
            acc += (w.pct || 0);
            stops.push(colors[i % colors.length] + ' ' + start.toFixed(2) + '% ' + acc.toFixed(2) + '%');
          });
          if (acc < 100) stops.push('var(--panel-2) ' + acc.toFixed(2) + '% 100%');
          var legend = bw.map(function (w, i) {
            return '<div class="rb-usage-legend-row"><span class="rb-usage-legend-dot" style="background:' +
              colors[i % colors.length] + '"></span><span class="rb-usage-legend-name" title="' + swmEsc(w.name) + '">' +
              swmEsc(w.name) + '</span><span class="rb-usage-legend-val">' + swmEsc(rbFmtTokens(w.tokens)) +
              ' · ' + w.pct + '%</span></div>';
          }).join('');
          donut.innerHTML = '<div class="rb-usage-donut-wrap"><div class="rb-usage-donut-ring" style="background:conic-gradient(' +
            stops.join(',') + ')"><div class="rb-usage-donut-hole"></div></div><div class="rb-usage-legend">' +
            legend + '</div></div>';
        }
      }
    }).catch(function () {
      kpiEl.innerHTML = '<div class="rb-usage-empty">加载失败</div>';
    });
  }
  function openUsagePanel() {
    try {
      var mask = document.getElementById('usage-mask');
      if (!mask) return;
      mask.classList.remove('usage-hidden');
      renderRbUsage();
    } catch (e) {}
  }
  function closeUsagePanel() {
    try {
      var mask = document.getElementById('usage-mask');
      if (mask) mask.classList.add('usage-hidden');
    } catch (e) {}
  }
  function initRbUsageUI() {
    try {
      var openBtn = document.getElementById('rb-btn-usage');
      if (openBtn) openBtn.addEventListener('click', openUsagePanel);
      var closeBtn = document.getElementById('usage-close');
      if (closeBtn) closeBtn.addEventListener('click', closeUsagePanel);
      var uMask = document.getElementById('usage-mask');
      if (uMask) uMask.addEventListener('click', function (e) { if (e.target === uMask) closeUsagePanel(); });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeUsagePanel();
      });
    } catch (e) {}
    var rangeEl = document.getElementById('rb-usage-range');
    if (rangeEl) {
      rangeEl.querySelectorAll('.rb-usage-range-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          rangeEl.querySelectorAll('.rb-usage-range-btn').forEach(function (b) { b.classList.remove('active'); });
          btn.classList.add('active');
          RB_USAGE_RANGE = Number(btn.getAttribute('data-range')) || 7;
          renderRbUsage();
        });
      });
    }
    var tabsEl = document.getElementById('rb-usage-activity-tabs');
    if (tabsEl) {
      tabsEl.querySelectorAll('.rb-usage-tab').forEach(function (btn) {
        btn.addEventListener('click', function () {
          tabsEl.querySelectorAll('.rb-usage-tab').forEach(function (b) { b.classList.remove('active'); });
          btn.classList.add('active');
          RB_USAGE_MODE = btn.getAttribute('data-mode') || 'cumulative';
          renderRbUsage();
        });
      });
    }
    renderRbUsage();
  }

  function renderShellStatsLog() {
    var logEl = swmEl('swm-stats-log');
    if (!logEl) return;
    var api = window.shellAPI;
    if (!api || !api.swmGetEventLog) {
      logEl.innerHTML = '<div class="swm-empty">不可用</div>';
      return;
    }
    var logP = api.swmGetEventLog(50).catch(function () { return null; });
    var profilesP = api.listProfiles().catch(function () { return null; });
    Promise.all([logP, profilesP]).then(function (arr) {
      var res = arr[0], pres = arr[1];
      var events = (res && res.success && res.events) || [];
      if (events.length === 0) {
        logEl.innerHTML = '<div class="swm-empty">暂无日志</div>';
        return;
      }
      var nameMap = {};
      ((pres && pres.success && pres.profiles) || []).forEach(function (p) { nameMap[p.id] = p.name; });
      logEl.innerHTML = events.map(function (ev) {
        var time = swmTimeKey(ev.ts);
        var win = nameMap[ev.profileId] || ev.profileId || '-';
        var type = ev.sub ? (ev.type + ':' + ev.sub) : ev.type;
        var detail = ev.detail || '';
        return '<div class="swm-stats-log-item">' +
          '<span class="swm-stats-log-time">' + time + '</span>' +
          '<span class="swm-stats-log-win" title="' + swmEsc(win) + '">' + swmEsc(win) + '</span>' +
          '<span class="swm-stats-log-type">' + swmEsc(type) + '</span>' +
          '<span class="swm-stats-log-detail" title="' + swmEsc(detail) + '">' + swmEsc(detail) + '</span>' +
        '</div>';
      }).join('');
    }).catch(function () {
      logEl.innerHTML = '<div class="swm-empty">加载失败</div>';
    });
  }

  // ---- 最近活动（运行统计内的 #swm-stats-events）----
  function renderShellStatsEvents() {
    var el = swmEl('swm-stats-events');
    if (!el) return;
    var api = window.shellAPI;
    if (!api || !api.swmGetEventLog) {
      el.innerHTML = '<div class="swm-empty">不可用</div>';
      return;
    }
    api.swmGetEventLog(30).then(function (res) {
      var events = (res && res.success && res.events) || [];
      if (!events.length) {
        el.innerHTML = '<div class="swm-empty">暂无活动</div>';
        return;
      }
      el.innerHTML = events.map(function (ev) {
        var ts = ev.ts || ev.time || Date.now();
        var d = new Date(ts);
        var hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        return '<div class="swm-stat-event">' +
          '<span class="swm-stat-event-t">' + hh + '</span>' +
          '<span class="swm-stat-event-k">' + swmEsc(ev.type || '?') + '</span>' +
          '<span class="swm-stat-event-d">' + swmEsc(ev.detail || ev.sub || '') + '</span>' +
        '</div>';
      }).join('');
    }).catch(function () {
      el.innerHTML = '<div class="swm-empty">加载失败</div>';
    });
  }

  // ---- 禁言倒计时每秒 tick（只更新文本，不重渲染列表）----
  function startShellWmBanTick() {
    if (startShellWmBanTick._started) return;
    startShellWmBanTick._started = true;
    setInterval(function () {
      var els = document.querySelectorAll('#swm-list .swm-item-state[data-ban-remain]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var remain = parseInt(el.getAttribute('data-ban-remain'), 10);
        if (!isFinite(remain) || remain <= 0) { el.removeAttribute('data-ban-remain'); continue; }
        remain -= 1;
        el.setAttribute('data-ban-remain', String(remain));
        el.innerHTML = '<span class="swm-dot">●</span>账号受限（剩余 ' + swmRemainText(remain) + '）';
      }
    }, 1000);
  }
  function swmRemainText(sec) {
    if (!sec || sec <= 0) return '0秒';
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    if (d > 0) return d + '天' + h + '小时' + m + '分';
    if (h > 0) return h + '小时' + m + '分';
    if (m > 0) return m + '分' + s + '秒';
    return s + '秒';
  }

  // ---- 窗口设置面板 ----
  var shellCfgProfileId = null;

  function swmCfgSet(id, v) { var el = swmEl(id); if (el) el.value = (v == null ? '' : v); }
  function swmCfgVal(id) { var el = swmEl(id); return el ? el.value.trim() : ''; }
  function swmCfgNum(id) { return parseInt(swmCfgVal(id), 10) || 0; }

  function openShellProfileConfig(profileId) {
    shellCfgProfileId = profileId;
    var panel = swmEl('swm-profile-config');
    if (!panel) return;
    panel.classList.remove('swm-hidden');
    // 名称
    var nameEl = swmEl('swm-cfg-name');
    if (nameEl) {
      var api = window.shellAPI;
      api.listProfiles().then(function (res) {
        var p = ((res && res.profiles) || []).find(function (x) { return x.id === profileId; });
        nameEl.textContent = p ? p.name : profileId;
      }).catch(function () { nameEl.textContent = profileId; });
    }
    var api2 = window.shellAPI;
    if (!api2 || !api2.swmGetProfileConfig) return;
    api2.swmGetProfileConfig(profileId).then(function (r) {
      if (r && r.success) {
        fillSwmAccountForm(r.account || {});
        fillSwmProxyForm(r.proxy || {});
        fillSwmFingerprintForm(r.fingerprint || {});
      }
    }).catch(function () {});
  }

  function fillSwmAccountForm(a) {
    fillSwmAccountBindOptions(a.accountId);
    swmCfgSet('swm-cfg-acct-label', a.label);
    swmCfgSet('swm-cfg-acct-email', a.email);
    swmCfgSet('swm-cfg-acct-group', a.group);
    swmCfgSet('swm-cfg-acct-status', a.status || 'active');
    swmCfgSet('swm-cfg-acct-quota', a.quotaLimit || 0);
  }
  function fillSwmProxyForm(p) {
    var chk = swmEl('swm-cfg-proxy-enabled'); if (chk) chk.checked = !!p.enabled;
    swmCfgSet('swm-cfg-proxy-protocol', p.protocol || 'http');
    swmCfgSet('swm-cfg-proxy-host', p.host);
    swmCfgSet('swm-cfg-proxy-port', p.port || '');
    swmCfgSet('swm-cfg-proxy-user', p.username);
    swmCfgSet('swm-cfg-proxy-pass', p.password);
    var res = swmEl('swm-cfg-proxy-result'); if (res) res.textContent = '';
  }
  function fillSwmFingerprintForm(f) {
    var chk = swmEl('swm-cfg-fp-enabled'); if (chk) chk.checked = !!f.enabled;
    swmCfgSet('swm-cfg-fp-os', f.os || '');
    swmCfgSet('swm-cfg-fp-tz', f.timezone);
    swmCfgSet('swm-cfg-fp-lang', f.language);
    swmCfgSet('swm-cfg-fp-cores', f.hardwareConcurrency || '');
    swmCfgSet('swm-cfg-fp-sw', f.screenWidth || '');
    swmCfgSet('swm-cfg-fp-sh', f.screenHeight || '');
    collectSwmFingerprint._last = f || {};
    renderSwmIdentityCard(f);
  }
  function renderSwmIdentityCard(fp) {
    var card = swmEl('swm-cfg-fp-card');
    if (!card) return;
    if (!fp || !fp.seed) { card.textContent = '尚未生成身份'; return; }
    var osName = { win: 'Windows', mac: 'macOS', linux: 'Linux' }[fp.os] || (fp.os || '跟随系统');
    card.textContent =
      '系统: ' + osName + '\n' +
      '时区: ' + (fp.timezone || '-') + '\n' +
      '语言: ' + (fp.language || '-') + '\n' +
      'CPU: ' + (fp.hardwareConcurrency || '-') + ' 核\n' +
      '屏幕: ' + (fp.screenWidth || '-') + 'x' + (fp.screenHeight || '-') + '\n' +
      '显卡: ' + String(fp.webglRenderer || '-').replace(/ANGLE \([^,]+, /, '').replace(/,.*/, '');
  }
  function collectSwmProxyForm() {
    var chk = swmEl('swm-cfg-proxy-enabled');
    return {
      enabled: !!(chk && chk.checked),
      mode: 'fixed_servers',
      protocol: swmCfgVal('swm-cfg-proxy-protocol') || 'http',
      host: swmCfgVal('swm-cfg-proxy-host'),
      port: swmCfgNum('swm-cfg-proxy-port'),
      username: swmCfgVal('swm-cfg-proxy-user'),
      password: swmCfgVal('swm-cfg-proxy-pass'),
    };
  }
  function collectSwmFingerprint() {
    var chk = swmEl('swm-cfg-fp-enabled');
    var prev = collectSwmFingerprint._last || {};
    return {
      enabled: !!(chk && chk.checked),
      os: swmCfgVal('swm-cfg-fp-os'),
      timezone: swmCfgVal('swm-cfg-fp-tz'),
      language: swmCfgVal('swm-cfg-fp-lang'),
      hardwareConcurrency: swmCfgNum('swm-cfg-fp-cores'),
      screenWidth: swmCfgNum('swm-cfg-fp-sw'),
      screenHeight: swmCfgNum('swm-cfg-fp-sh'),
      webglVendor: prev.webglVendor || '',
      webglRenderer: prev.webglRenderer || '',
      deviceMemory: prev.deviceMemory || 8,
      seed: prev.seed || 0,
    };
  }
  var SWM_IDENTITY_PRESETS = [
    { os: 'win', timezone: 'Asia/Shanghai', language: 'zh-CN', hardwareConcurrency: 8, screenWidth: 1920, screenHeight: 1080, webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { os: 'win', timezone: 'Asia/Shanghai', language: 'zh-CN', hardwareConcurrency: 16, screenWidth: 2560, screenHeight: 1440, webglVendor: 'Google Inc. (Intel)', webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { os: 'win', timezone: 'America/New_York', language: 'en-US', hardwareConcurrency: 12, screenWidth: 1920, screenHeight: 1080, webglVendor: 'Google Inc. (AMD)', webglRenderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { os: 'mac', timezone: 'America/Los_Angeles', language: 'en-US', hardwareConcurrency: 10, screenWidth: 2560, screenHeight: 1600, webglVendor: 'Google Inc. (Apple)', webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
    { os: 'linux', timezone: 'Europe/Berlin', language: 'de-DE', hardwareConcurrency: 4, screenWidth: 1920, screenHeight: 1080, webglVendor: 'Google Inc. (Intel)', webglRenderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)' },
  ];
  function swmCurrentRealOs() {
    var p = (navigator.platform || '').toLowerCase();
    var ua = (navigator.userAgent || '').toLowerCase();
    if (p.indexOf('mac') !== -1 || ua.indexOf('macintosh') !== -1 || ua.indexOf('mac os') !== -1) return 'mac';
    if (p.indexOf('linux') !== -1 || ua.indexOf('linux') !== -1) return 'linux';
    return 'win';
  }
  function generateSwmIdentity() {
    var realOs = swmCurrentRealOs();
    var pool = SWM_IDENTITY_PRESETS.filter(function (x) { return x.os === realOs; });
    var list = pool.length > 0 ? pool : SWM_IDENTITY_PRESETS;
    var p = list[Math.floor(Math.random() * list.length)];
    return Object.assign({}, p, { enabled: true, seed: Math.floor(Math.random() * 1000000), deviceMemory: 8 });
  }
  function parseSwmProxyUrl(str) {
    var s = (str || '').trim();
    if (!s) return null;
    var protocol = 'http', rest = s;
    var m = s.match(/^(https?|socks5?):\/\/(.+)$/i);
    if (m) {
      var p = m[1].toLowerCase();
      protocol = (p === 'socks' || p === 'socks5') ? 'socks5' : p;
      rest = m[2];
    }
    var username = '', password = '', host = '', port = 0;
    var at = rest.lastIndexOf('@');
    if (at !== -1) {
      var cred = rest.slice(0, at);
      rest = rest.slice(at + 1);
      var ci = cred.indexOf(':');
      if (ci !== -1) { username = decodeURIComponent(cred.slice(0, ci)); password = decodeURIComponent(cred.slice(ci + 1)); }
      else username = decodeURIComponent(cred);
    }
    var hp = rest.split(':');
    host = hp[0];
    port = parseInt(hp[1], 10) || 0;
    if (!host) return null;
    return { enabled: true, mode: 'fixed_servers', protocol: protocol, host: host, port: port, username: username, password: password };
  }
  function fillSwmAccountBindOptions(currentAccountId) {
    var sel = swmEl('swm-cfg-acct-bind');
    if (!sel) return;
    var api = window.shellAPI;
    if (!api || !api.swmListAccounts) return;
    api.swmListAccounts().then(function (res) {
      var accounts = (res && res.success && res.accounts) || [];
      sel.innerHTML = '<option value="">（不绑定）</option>' +
        accounts.map(function (a) {
          var text = (a.label || a.username || a.id) + (a.providerId ? ' · ' + a.providerId : '');
          return '<option value="' + swmEsc(a.id) + '">' + swmEsc(text) + '</option>';
        }).join('');
      sel.value = currentAccountId || '';
    }).catch(function () { sel.innerHTML = '<option value="">（加载失败）</option>'; });
  }

  // ---- 改角色菜单（壳层，轻量版）----
  function openShellRoleMenu(anchorEl, profileId, profiles) {
    var old = swmEl('swm-role-menu');
    if (old) old.remove();
    var menu = document.createElement('div');
    menu.id = 'swm-role-menu';
    menu.className = 'swm-role-menu';
    function item(text, fn) {
      var d = document.createElement('div');
      d.className = 'swm-role-item';
      d.textContent = text;
      d.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
      return d;
    }
    function apply(role, belongTo) {
      var api = window.shellAPI;
      if (!api || !api.swmSetProfileRole) return;
      api.swmSetProfileRole(profileId, role, belongTo || '').then(function (r) {
        if (!r || !r.success) window.alert((r && r.error) || '设置失败');
        menu.remove();
        renderShellWindowList();
      }).catch(function () { menu.remove(); });
    }
    menu.appendChild(item('设为主大脑', function () { apply('master', ''); }));
    // 设为子Agent：展开归属下拉
    var workerItem = item('设为子Agent', function () {});
    menu.appendChild(workerItem);
    var row = document.createElement('div');
    row.className = 'swm-role-row';
    row.style.display = 'none';
    var sel = document.createElement('select');
    sel.className = 'swm-input';
    sel.innerHTML = '<option value="">不指定归属</option>' +
      (profiles || []).filter(function (p) { return p.id !== profileId; })
        .map(function (p) { return '<option value="' + swmEsc(p.id) + '">' + swmEsc(p.name) + '</option>'; }).join('');
    var ok = document.createElement('button');
    ok.className = 'swm-mini swm-btn-primary';
    ok.textContent = '确定';
    ok.addEventListener('click', function (e) { e.stopPropagation(); apply('worker', sel.value); });
    row.appendChild(sel); row.appendChild(ok);
    menu.appendChild(row);
    workerItem.addEventListener('click', function (e) {
      e.stopPropagation();
      row.style.display = (row.style.display === 'none') ? 'flex' : 'none';
    });
    menu.appendChild(item('清除角色', function () { apply('', ''); }));

    document.body.appendChild(menu);
    // 定位到按钮下方
    var rect = null;
    try { rect = anchorEl.getBoundingClientRect(); } catch (_) {}
    if (rect) {
      menu.style.position = 'fixed';
      menu.style.left = Math.max(4, Math.min(rect.right - 160, window.innerWidth - 170)) + 'px';
      menu.style.top = (rect.bottom + 4) + 'px';
    }
    setTimeout(function () {
      document.addEventListener('mousedown', function onDown(ev) {
        if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', onDown, true); }
      }, true);
    }, 0);
  }

  // 切换/聚焦某 profile：已在标签中打开 → switchTab；未打开 → 请主进程在壳内开新标签
  function openShellProfile(profileId) {
    var t = findTabByProfile(profileId);
    if (t) {
      switchTab(t.id);
      closeShellWindowManager();
      return;
    }
    if (window.shellAPI && window.shellAPI.openProfileWindow) {
      window.shellAPI.openProfileWindow(profileId).then(function () {
        closeShellWindowManager();
      }).catch(function () {});
    }
  }

  // ---- 窗口设置面板事件绑定 ----
  function bindShellProfileConfigEvents() {
    var api = window.shellAPI;
    if (!api) return;
    // tab 切换
    var tabs = document.querySelectorAll('#swm-profile-config .swm-cfg-tab');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var name = tab.getAttribute('data-tab');
        tabs.forEach(function (t) { t.classList.toggle('swm-cfg-tab-active', t === tab); });
        document.querySelectorAll('#swm-profile-config .swm-cfg-pane').forEach(function (p) {
          p.classList.toggle('swm-hidden', p.getAttribute('data-pane') !== name);
        });
      });
    });
    // 关闭
    var closeBtn = swmEl('swm-cfg-close');
    if (closeBtn) closeBtn.addEventListener('click', function () {
      var panel = swmEl('swm-profile-config');
      if (panel) panel.classList.add('swm-hidden');
    });
    // 保存账号
    var acctSave = swmEl('swm-cfg-acct-save');
    if (acctSave) acctSave.addEventListener('click', function () {
      if (!shellCfgProfileId) return;
      var account = {
        label: swmCfgVal('swm-cfg-acct-label'),
        email: swmCfgVal('swm-cfg-acct-email'),
        group: swmCfgVal('swm-cfg-acct-group'),
        status: swmCfgVal('swm-cfg-acct-status') || 'active',
        quotaLimit: swmCfgNum('swm-cfg-acct-quota'),
      };
      api.swmSetProfileAccount(shellCfgProfileId, account).then(function (r) {
        window.alert(r && r.success ? '账号已保存' : ('保存失败: ' + ((r && r.error) || '未知')));
      }).catch(function () {});
    });
    // 绑定账号下拉
    var bindSel = swmEl('swm-cfg-acct-bind');
    if (bindSel) bindSel.addEventListener('change', function (e) {
      if (!shellCfgProfileId) return;
      api.swmBindAccount(shellCfgProfileId, e.target.value || '').then(function (r) {
        window.alert(r && r.success ? '已绑定账号，正在尝试自动登录…' : ('绑定失败: ' + ((r && r.error) || '未知')));
      }).catch(function () {});
    });
    // 立即重登
    var relogin = swmEl('swm-cfg-acct-relogin');
    if (relogin) relogin.addEventListener('click', function () {
      if (!shellCfgProfileId) return;
      api.swmTriggerRelogin(shellCfgProfileId).then(function () {}).catch(function () {});
    });
    // 测试代理
    var proxyTest = swmEl('swm-cfg-proxy-test');
    if (proxyTest) proxyTest.addEventListener('click', function () {
      if (!shellCfgProfileId) return;
      var resEl = swmEl('swm-cfg-proxy-result');
      if (resEl) resEl.textContent = '测试中…';
      api.swmTestProfileProxy(shellCfgProfileId, collectSwmProxyForm()).then(function (r) {
        if (resEl) resEl.textContent = r && r.success ? ('✔ 连通，出口 IP: ' + r.ip + '（' + r.ms + 'ms）') : ('✘ 失败: ' + ((r && r.error) || '未知'));
      }).catch(function (err) { if (resEl) resEl.textContent = '✘ ' + (err.message || err); });
    });
    // 解析代理
    var proxyParse = swmEl('swm-cfg-proxy-parse');
    if (proxyParse) proxyParse.addEventListener('click', function () {
      var parsed = parseSwmProxyUrl(swmCfgVal('swm-cfg-proxy-paste'));
      if (!parsed) { window.alert('无法解析，请检查格式'); return; }
      swmCfgSet('swm-cfg-proxy-protocol', parsed.protocol);
      swmCfgSet('swm-cfg-proxy-host', parsed.host);
      swmCfgSet('swm-cfg-proxy-port', parsed.port);
      swmCfgSet('swm-cfg-proxy-user', parsed.username);
      swmCfgSet('swm-cfg-proxy-pass', parsed.password);
      var chk = swmEl('swm-cfg-proxy-enabled'); if (chk) chk.checked = true;
    });
    // 保存代理
    var proxySave = swmEl('swm-cfg-proxy-save');
    if (proxySave) proxySave.addEventListener('click', function () {
      if (!shellCfgProfileId) return;
      api.swmSetProfileProxy(shellCfgProfileId, collectSwmProxyForm()).then(function (r) {
        window.alert(r && r.success ? '代理已保存（已打开的窗口立即生效）' : ('保存失败: ' + ((r && r.error) || '未知')));
      }).catch(function () {});
    });
    // 一键生成随机身份
    var fpRandom = swmEl('swm-cfg-fp-random');
    if (fpRandom) fpRandom.addEventListener('click', function () {
      if (!shellCfgProfileId) return;
      var identity = generateSwmIdentity();
      api.swmSetProfileFingerprint(shellCfgProfileId, identity).then(function (r) {
        if (r && r.success) { fillSwmFingerprintForm(identity); window.alert('已生成新身份，点「保存并应用」后重启窗口生效'); }
        else window.alert('生成失败: ' + ((r && r.error) || '未知'));
      }).catch(function () {});
    });
    // 保存指纹
    var fpSave = swmEl('swm-cfg-fp-save');
    if (fpSave) fpSave.addEventListener('click', function () {
      if (!shellCfgProfileId) return;
      api.swmSetProfileFingerprint(shellCfgProfileId, collectSwmFingerprint()).then(function (r) {
        window.alert(r && r.success ? '指纹已保存（需重启窗口生效）' : ('保存失败: ' + ((r && r.error) || '未知')));
      }).catch(function () {});
    });
    // 换新身份
    var fpReseed = swmEl('swm-cfg-fp-reseed');
    if (fpReseed) fpReseed.addEventListener('click', function () {
      if (!shellCfgProfileId) return;
      var fp = collectSwmFingerprint();
      fp.seed = Math.floor(Math.random() * 1000000);
      api.swmSetProfileFingerprint(shellCfgProfileId, fp).then(function (r) {
        window.alert(r && r.success ? ('已换新身份 seed=' + fp.seed + '（重启窗口生效）') : ('失败: ' + ((r && r.error) || '未知')));
      }).catch(function () {});
    });
  }

  // 浮层拖拽（标题栏拖动；用 transform 偏移，基础位置由 mask flex 居中）
  (function bindShellWmDrag() {
    var header = swmEl('swm-header');
    var panel = swmEl('swm-panel');
    if (!header || !panel) return;
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    header.addEventListener('mousedown', function (e) {
      if (e.target && e.target.closest && e.target.closest('button')) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY; ox = panel._swmX || 0; oy = panel._swmY || 0;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      panel._swmX = ox + (e.clientX - sx);
      panel._swmY = oy + (e.clientY - sy);
      panel.style.transform = 'translate(' + panel._swmX + 'px,' + panel._swmY + 'px)';
    });
    document.addEventListener('mouseup', function () { dragging = false; });
  })();

  (function bindShellWm() {
    var btn = document.getElementById('rb-btn-window-manager');
    if (btn) {
      btn.addEventListener('click', function () {
        if (isShellWindowManagerOpen()) closeShellWindowManager();
        else openShellWindowManager();
      });
    }
    var closeBtn = swmEl('swm-close');
    if (closeBtn) closeBtn.addEventListener('click', closeShellWindowManager);
    var refreshBtn = swmEl('swm-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', renderShellWindowList);
    var newBtn = swmEl('swm-new-window');
    if (newBtn) {
      newBtn.addEventListener('click', function () {
        if (window.shellAPI && window.shellAPI.createProfileWindow) {
          window.shellAPI.createProfileWindow().then(function () {
            setTimeout(renderShellWindowList, 400);
          }).catch(function () {});
        }
      });
    }
    // 点击遮罩空白处关闭
    var mask = swmEl('swm-mask');
    if (mask) {
      mask.addEventListener('click', function (e) {
        if (e.target === mask) closeShellWindowManager();
      });
    }
    // 平台选择浮层：关闭按钮 + 点击遮罩空白处关闭
    var psmClose = document.getElementById('psm-close');
    if (psmClose) psmClose.addEventListener('click', closePlatformSelect);
    var psmMask = document.getElementById('psm-mask');
    if (psmMask) {
      psmMask.addEventListener('click', function (e) {
        if (e.target === psmMask) closePlatformSelect();
      });
    }
    // 看门狗：暂停/恢复
    var wdToggle = swmEl('swm-wd-toggle');
    if (wdToggle) wdToggle.addEventListener('click', function () {
      var api = window.shellAPI;
      if (!api || !api.swmWatchdogGetConfig) return;
      api.swmWatchdogGetConfig().then(function (res) {
        var cfg = res && res.success ? res.config : null;
        var next = cfg ? !cfg.paused : true;
        return api.swmWatchdogSetPaused(next).then(function () { renderShellWatchdogPanel(); });
      }).catch(function () {});
    });
    // 看门狗：立即唤醒（需当前激活标签的 profileId）
    var wdWake = swmEl('swm-wd-wake');
    if (wdWake) wdWake.addEventListener('click', function () {
      var api = window.shellAPI;
      var pid = shellActiveProfileId();
      if (!api || !api.swmWatchdogWake || !pid) return;
      api.swmWatchdogWake(pid).then(function () { renderShellWatchdogPanel(); }).catch(function () {});
    });
    // 看门狗：刷新
    var wdRefresh = swmEl('swm-wd-refresh');
    if (wdRefresh) wdRefresh.addEventListener('click', renderShellWatchdogPanel);

    // 数据看板：手动刷新
    var dbRefresh = swmEl('swm-db-refresh');
    if (dbRefresh) dbRefresh.addEventListener('click', renderShellDashboard);

    // 运行统计：查看/收起日志
    var statsLogBtn = swmEl('swm-stats-log-btn');
    if (statsLogBtn) statsLogBtn.addEventListener('click', function () {
      var logEl = swmEl('swm-stats-log');
      if (!logEl) return;
      var hidden = logEl.classList.contains('swm-hidden');
      if (hidden) {
        logEl.classList.remove('swm-hidden');
        statsLogBtn.textContent = '收起日志';
        renderShellStatsLog();
      } else {
        logEl.classList.add('swm-hidden');
        statsLogBtn.textContent = '查看日志';
      }
    });

    bindShellProfileConfigEvents();

    // Esc 关闭
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isShellWindowManagerOpen()) closeShellWindowManager();
    });
  })();


  // ===== 全局 MCP 管理浮层（壳层级，跨标签共享） =====
  function smcpEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function smcpOpen() {
    var mask = document.getElementById('smcp-mask');
    if (!mask) return;
    mask.classList.remove('swm-hidden');
    renderShellMcpList();
    loadShellMcpConfigToJson();
  }
  function smcpClose() {
    var mask = document.getElementById('smcp-mask');
    if (mask) mask.classList.add('swm-hidden');
  }
  function smcpIsOpen() {
    var mask = document.getElementById('smcp-mask');
    return !!(mask && !mask.classList.contains('swm-hidden'));
  }

  function loadShellMcpConfigToJson() {
    var api = window.shellAPI;
    var jsonInput = document.getElementById('smcp-json');
    if (!api || !api.mcpListServers || !jsonInput) return;
    api.mcpListServers().then(function (res) {
      var servers = (res && res.success && res.servers) || [];
      var mcpServers = {};
      servers.forEach(function (s) {
        var def = {};
        if (s.type === 'http') {
          if (s.url) def.url = s.url;
          if (s.headers) def.headers = s.headers;
        } else {
          if (s.command) def.command = s.command;
          if (s.args && s.args.length) def.args = s.args;
          if (s.env) def.env = s.env;
        }
        mcpServers[s.name] = def;
      });
      jsonInput.value = JSON.stringify({ mcpServers: mcpServers }, null, 2);
    }).catch(function () {});
  }

  function renderShellMcpList() {
    var api = window.shellAPI;
    var list = document.getElementById('smcp-list');
    if (!list) return;
    if (!api || !api.mcpListServers) {
      list.innerHTML = '<div class="swm-empty">当前环境不支持 MCP</div>';
      return;
    }
    list.innerHTML = '<div class="swm-empty">加载中…</div>';
    api.mcpListServers().then(function (res) {
      var servers = (res && res.success && res.servers) || [];
      if (!servers.length) {
        list.innerHTML = '<div class="swm-empty">暂无 MCP Server</div>';
        return;
      }
      list.innerHTML = servers.map(function (s) {
        var status = s.connected ? '已连接' : (s.enabled ? '未连接' : '已禁用');
        var color = s.connected ? '#4ade80' : (s.enabled ? '#ffc107' : '#5d6280');
        return '<div class="smcp-item" data-mcp-name="' + smcpEsc(s.name) + '" title="' + smcpEsc(status) + '">' +
          '<span class="smcp-item-name">' + smcpEsc(s.name) + '</span>' +
          '<span class="smcp-dot" style="background:' + color + '"></span>' +
        '</div>';
      }).join('');
      list.querySelectorAll('.smcp-item').forEach(function (el) {
        el.addEventListener('click', function () {
          var name = el.getAttribute('data-mcp-name');
          var server = null;
          for (var i = 0; i < servers.length; i++) { if (servers[i].name === name) { server = servers[i]; break; } }
          if (!server) return;
          var dot = el.querySelector('.smcp-dot');
          if (dot) dot.style.background = '#ffc107';
          el.style.pointerEvents = 'none';
          var op = (server.connected || server.enabled)
            ? api.mcpDisableServer(name)
            : api.mcpEnableServer(name);
          Promise.resolve(op).then(function () {
            renderShellMcpList();
            loadShellMcpConfigToJson();
          }).catch(function () {
            renderShellMcpList();
          });
        });
      });
    }).catch(function () {
      list.innerHTML = '<div class="swm-empty">加载失败</div>';
    });
  }

  function saveShellMcpConfig() {
    var api = window.shellAPI;
    var jsonInput = document.getElementById('smcp-json');
    if (!api || !jsonInput || !jsonInput.value.trim()) {
      shellToast('请输入配置');
      return;
    }
    var parsed;
    try {
      parsed = JSON.parse(jsonInput.value);
    } catch (e) {
      shellToast('JSON 解析失败');
      return;
    }
    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
      shellToast('配置格式错误，需要 mcpServers 对象');
      return;
    }
    var names = Object.keys(parsed.mcpServers);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var def = parsed.mcpServers[name];
      if (!def || typeof def !== 'object' || Array.isArray(def)) {
        shellToast('配置错误：server "' + name + '" 的定义必须是对象'); return;
      }
      var hasUrl = def.url !== undefined;
      var hasCommand = def.command !== undefined;
      if (hasUrl && hasCommand) { shellToast('配置错误：server "' + name + '" 不能同时指定 url 和 command'); return; }
      if (hasUrl) {
        if (typeof def.url !== 'string' || !def.url.trim()) { shellToast('配置错误：server "' + name + '" 的 url 必须是非空字符串'); return; }
      } else if (hasCommand) {
        if (typeof def.command !== 'string' || !def.command.trim()) { shellToast('配置错误：server "' + name + '" 的 command 必须是非空字符串'); return; }
      } else {
        shellToast('配置错误：server "' + name + '" 缺少 command 或 url'); return;
      }
      if (def.args !== undefined && !Array.isArray(def.args)) { shellToast('配置错误：server "' + name + '" 的 args 必须是数组'); return; }
    }
    api.mcpListServers().then(function (oldRes) {
      var oldServers = (oldRes && oldRes.success && oldRes.servers) || [];
      var newNames = {};
      names.forEach(function (n) { newNames[n] = 1; });
      var chain = Promise.resolve();
      oldServers.forEach(function (old) {
        if (!newNames[old.name]) {
          chain = chain.then(function () { return api.mcpRemoveServer(old.name); });
        }
      });
      names.forEach(function (name) {
        var def = parsed.mcpServers[name];
        var server = {
          name: name,
          type: (def && def.url) ? 'http' : 'stdio',
          command: def && def.command,
          args: (def && def.args) || [],
          url: def && def.url,
          headers: def && def.headers,
          env: def && def.env,
        };
        chain = chain.then(function () { return api.mcpUpsertServer(server); });
      });
      return chain;
    }).then(function () {
      shellToast('配置已保存');
      renderShellMcpList();
      loadShellMcpConfigToJson();
    }).catch(function (e) {
      shellToast('保存失败：' + ((e && e.message) || e));
    });
  }

  // ===== 全局账号池浮层（壳层级，跨标签共享） =====
  var sapAccounts = [];
  var sapSelected = null;

  function sapOpen() {
    var mask = document.getElementById('sap-mask');
    if (!mask) return;
    mask.classList.remove('swm-hidden');
    renderShellAccountList();
  }
  function sapClose() {
    var mask = document.getElementById('sap-mask');
    if (mask) mask.classList.add('swm-hidden');
  }
  function sapIsOpen() {
    var mask = document.getElementById('sap-mask');
    return !!(mask && !mask.classList.contains('swm-hidden'));
  }

  function renderShellAccountList() {
    var api = window.shellAPI;
    var list = document.getElementById('sap-list');
    if (!list) return;
    if (!api || !api.accountList) {
      list.innerHTML = '<div class="swm-empty">当前环境不支持账号池</div>';
      return;
    }
    list.innerHTML = '<div class="swm-empty">加载中…</div>';
    var usageP = (api.accountUsageList ? api.accountUsageList() : Promise.resolve(null)).catch(function () { return null; });
    Promise.all([api.accountList(), usageP]).then(function (arr) {
      var res = arr[0], ures = arr[1];
      var accounts = (res && res.success && res.accounts) || [];
      sapAccounts = accounts;
      var usage = (ures && ures.success && ures.usage) || {};
      if (!accounts.length) {
        list.innerHTML = '<div class="swm-empty">暂无账号</div>';
        updateSapButtons();
        return;
      }
      list.innerHTML = accounts.map(function (a) {
        var active = sapSelected === a.id ? ' sap-item-active' : '';
        var usedBy = usage[a.id] || [];
        var usedTag = usedBy.length ? ' · 已被 ' + usedBy.map(function (u) { return u.profileName || u.profileId; }).join(', ') + ' 使用' : '';
        var sub = (a.username || '') + (a.providerId ? ' · ' + a.providerId : '') + (a.hasPassword ? '' : ' · 无密码') + usedTag;
        return '<div class="sap-item' + active + '" data-acct-id="' + smcpEsc(a.id) + '">' +
          '<span class="sap-item-name" title="' + smcpEsc(a.label || a.username || a.id) + '">' + smcpEsc(a.label || '(未命名)') + '</span>' +
          '<span class="sap-item-sub" title="' + smcpEsc(sub) + '">' + smcpEsc(sub) + '</span>' +
        '</div>';
      }).join('');
      list.querySelectorAll('.sap-item').forEach(function (el) {
        el.addEventListener('click', function () { selectShellAccount(el.getAttribute('data-acct-id')); });
      });
      updateSapButtons();
    }).catch(function () {
      list.innerHTML = '<div class="swm-empty">加载失败</div>';
      updateSapButtons();
    });
  }

  function selectShellAccount(id) {
    var a = null;
    for (var i = 0; i < sapAccounts.length; i++) { if (sapAccounts[i].id === id) { a = sapAccounts[i]; break; } }
    if (!a) return;
    sapSelected = id;
    var set = function (eid, v) { var el = document.getElementById(eid); if (el) el.value = (v == null ? '' : v); };
    set('sap-label', a.label);
    set('sap-username', a.username);
    set('sap-password', '');
    set('sap-provider', a.providerId);
    set('sap-group', a.group);
    set('sap-note', a.note);
    var empty = document.getElementById('sap-empty');
    if (empty) empty.classList.add('swm-hidden');
    var list = document.getElementById('sap-list');
    if (list) list.querySelectorAll('.sap-item').forEach(function (el) {
      el.classList.toggle('sap-item-active', el.getAttribute('data-acct-id') === id);
    });
    updateSapButtons();
  }

  function clearShellAccountForm() {
    sapSelected = null;
    ['sap-label','sap-username','sap-password','sap-provider','sap-group','sap-note'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.value = '';
    });
    var empty = document.getElementById('sap-empty');
    if (empty) empty.classList.remove('swm-hidden');
    var list = document.getElementById('sap-list');
    if (list) list.querySelectorAll('.sap-item').forEach(function (el) { el.classList.remove('sap-item-active'); });
    updateSapButtons();
  }

  function updateSapButtons() {
    var delBtn = document.getElementById('sap-delete');
    if (delBtn) delBtn.classList.toggle('swm-hidden', !sapSelected);
  }

  function saveShellAccountForm() {
    var api = window.shellAPI;
    if (!api || !api.accountCreate || !api.accountUpdate) return;
    var val = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
    var base = {
      label: val('sap-label'),
      username: val('sap-username'),
      providerId: val('sap-provider'),
      group: val('sap-group'),
      note: val('sap-note'),
    };
    var pwd = val('sap-password');
    if (sapSelected) {
      var patch = Object.assign({}, base);
      if (pwd) patch.password = pwd;
      api.accountUpdate(sapSelected, patch).then(function (r) {
        if (r && r.success) {
          shellToast(r.warning ? ('已保存（' + r.warning + '）') : '账号已保存');
          return renderShellAccountList();
        }
        shellToast((r && r.error) || '保存失败');
      }).catch(function (e) { shellToast('保存失败：' + ((e && e.message) || e)); });
    } else {
      if (!base.username) { shellToast('请填写登录名'); return; }
      if (!base.providerId) { shellToast('请填写平台（providerId）'); return; }
      var data = Object.assign({}, base);
      if (pwd) data.password = pwd;
      api.accountCreate(data).then(function (r) {
        if (r && r.success) {
          shellToast(r.warning ? ('已创建（' + r.warning + '）') : '账号已创建');
          return renderShellAccountList().then(function () { if (r.id) selectShellAccount(r.id); });
        }
        shellToast((r && r.error) || '创建失败');
      }).catch(function (e) { shellToast('保存失败：' + ((e && e.message) || e)); });
    }
  }

  function deleteShellAccount() {
    var api = window.shellAPI;
    if (!api || !api.accountDelete || !sapSelected) return;
    if (!window.confirm('确定删除该账号？此操作不可恢复。')) return;
    api.accountDelete(sapSelected).then(function (r) {
      if (r && r.success) {
        shellToast('已删除');
        clearShellAccountForm();
        return renderShellAccountList();
      }
      shellToast((r && r.error) || '删除失败');
    }).catch(function (e) { shellToast('删除失败：' + ((e && e.message) || e)); });
  }

  (function bindShellMcpAndAccount() {
    var mcpBtn = document.getElementById('rb-btn-mcp');
    if (mcpBtn) mcpBtn.addEventListener('click', function () { smcpIsOpen() ? smcpClose() : smcpOpen(); });
    var mcpCloseBtn = document.getElementById('smcp-close');
    if (mcpCloseBtn) mcpCloseBtn.addEventListener('click', smcpClose);
    var mcpRefreshBtn = document.getElementById('smcp-refresh');
    if (mcpRefreshBtn) mcpRefreshBtn.addEventListener('click', function () { renderShellMcpList(); loadShellMcpConfigToJson(); });
    var mcpSaveBtn = document.getElementById('smcp-save');
    if (mcpSaveBtn) mcpSaveBtn.addEventListener('click', saveShellMcpConfig);
    var mcpMask = document.getElementById('smcp-mask');
    if (mcpMask) mcpMask.addEventListener('click', function (e) { if (e.target === mcpMask) smcpClose(); });

    var acctBtn = document.getElementById('rb-btn-account-pool');
    if (acctBtn) acctBtn.addEventListener('click', function () { sapIsOpen() ? sapClose() : sapOpen(); });
    var acctCloseBtn = document.getElementById('sap-close');
    if (acctCloseBtn) acctCloseBtn.addEventListener('click', sapClose);
    var acctRefreshBtn = document.getElementById('sap-refresh');
    if (acctRefreshBtn) acctRefreshBtn.addEventListener('click', renderShellAccountList);
    var acctNewBtn = document.getElementById('sap-new');
    if (acctNewBtn) acctNewBtn.addEventListener('click', clearShellAccountForm);
    var acctSaveBtn = document.getElementById('sap-save');
    if (acctSaveBtn) acctSaveBtn.addEventListener('click', saveShellAccountForm);
    var acctDelBtn = document.getElementById('sap-delete');
    if (acctDelBtn) acctDelBtn.addEventListener('click', deleteShellAccount);
    var acctMask = document.getElementById('sap-mask');
    if (acctMask) acctMask.addEventListener('click', function (e) { if (e.target === acctMask) sapClose(); });

    [['smcp-header', 'smcp-panel'], ['sap-header', 'sap-panel']].forEach(function (pair) {
      var header = document.getElementById(pair[0]);
      var panel = document.getElementById(pair[1]);
      if (!header || !panel) return;
      var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
      header.addEventListener('mousedown', function (e) {
        if (e.target && e.target.closest && e.target.closest('button')) return;
        dragging = true;
        sx = e.clientX; sy = e.clientY; ox = panel._sx || 0; oy = panel._sy || 0;
        e.preventDefault();
      });
      document.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        panel._sx = ox + (e.clientX - sx);
        panel._sy = oy + (e.clientY - sy);
        panel.style.transform = 'translate(' + panel._sx + 'px,' + panel._sy + 'px)';
      });
      document.addEventListener('mouseup', function () { dragging = false; });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (smcpIsOpen()) smcpClose();
      if (sapIsOpen()) sapClose();
    });
  })();

  // ===== 全局知识库浮层（壳层级，跨标签共享，切标签不消失） =====
  var skmSkills = [];
  var skmEnabled = [];       // 本项目启用
  var skmGlobal = [];        // 全局启用
  var skmSelected = null;
  var skmVersions = [];        // 当前技能的历史版本
  var skmVersionsOpen = false; // 版本区是否展开

  function skmEl(id) { return document.getElementById(id); }
  function skmEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 当前活动标签的项目目录（右栏文本即真源，由 applyRightBarFromWeb 同步）
  function skmActiveProjectDir() {
    var el = document.getElementById('rb-project-dir');
    var dir = el ? String(el.textContent || '').trim() : '';
    if (!dir || dir === '未选择') return '';
    return dir;
  }

  function skmOpen() {
    var mask = skmEl('skm-mask');
    if (!mask) return;
    mask.classList.remove('swm-hidden');
    renderShellKnowledge();
    loadShellPreferences();
  }
  function skmClose() {
    var mask = skmEl('skm-mask');
    if (mask) mask.classList.add('swm-hidden');
  }
  function skmIsOpen() {
    var mask = skmEl('skm-mask');
    return !!(mask && !mask.classList.contains('swm-hidden'));
  }

  function renderShellKnowledge() {
    var api = window.shellAPI;
    var list = skmEl('skm-list');
    if (!list) return;
    if (!api || !api.knowledgeList) {
      list.innerHTML = '<div class="swm-empty">当前环境不支持知识库</div>';
      return;
    }
    var dir = skmActiveProjectDir();
    var dirEl = skmEl('skm-project-dir');
    if (dirEl) { dirEl.textContent = dir ? ('项目：' + dir) : '未选择项目'; dirEl.title = dir || ''; }
    list.innerHTML = '<div class="swm-empty">加载中…</div>';
    api.knowledgeList(dir).then(function (res) {
      skmSkills = (res && res.success && res.skills) || [];
      skmEnabled = (res && res.success && res.enabled) || [];
      skmGlobal = (res && res.success && res.globalEnabled) || [];
      if (!skmSkills.length) {
        list.innerHTML = '<div class="swm-empty">暂无技能</div>';
        updateSkmButtons();
        return;
      }
      var enabledSet = {};
      skmEnabled.forEach(function (n) { enabledSet[n] = 1; });
      var globalSet = {};
      skmGlobal.forEach(function (n) { globalSet[n] = 1; });
      list.innerHTML = skmSkills.map(function (s) {
        var active = skmSelected === s.name ? ' skm-item-active' : '';
        var projOn = !!enabledSet[s.name];
        var globOn = !!globalSet[s.name];
        var badges = '<span class="skm-badge' + (projOn ? ' skm-badge-on' : '') + '" title="本项目' + (projOn ? '已启用' : '未启用') + '">项目</span>' +
          '<span class="skm-badge' + (globOn ? ' skm-badge-g' : '') + '" title="全局' + (globOn ? '已启用' : '未启用') + '">全局</span>';
        return '<div class="skm-item' + active + '" data-skm-name="' + skmEsc(s.name) + '">' +
          '<div class="skm-item-main">' +
            '<span class="skm-item-name">' + skmEsc(s.name) + '</span>' +
            '<span class="skm-item-sub" title="' + skmEsc(s.description || '（无描述）') + '">' + skmEsc(s.description || '（无描述）') + '</span>' +
          '</div>' +
          '<span class="skm-badges">' + badges + '</span>' +
        '</div>';
      }).join('');
      list.querySelectorAll('.skm-item').forEach(function (el) {
        el.addEventListener('click', function () { selectShellKnowledge(el.getAttribute('data-skm-name')); });
      });
      updateSkmButtons();
    }).catch(function () {
      list.innerHTML = '<div class="swm-empty">加载失败</div>';
      updateSkmButtons();
    });
  }

  function selectShellKnowledge(name) {
    var api = window.shellAPI;
    if (!api || !api.knowledgeRead) return;
    api.knowledgeRead(name).then(function (res) {
      if (!res || !res.success) { shellToast((res && res.error) || '读取失败'); return; }
      skmSelected = name;
      var empty = skmEl('skm-empty');
      var nameInput = skmEl('skm-name');
      var content = skmEl('skm-content');
      if (empty) empty.classList.add('skm-hidden');
      if (nameInput) { nameInput.classList.add('skm-hidden'); nameInput.value = name; }
      if (content) content.value = res.content || '';
      skmVersions = []; skmVersionsOpen = false;
      updateSkmButtons();
      renderSkillVersions();
      var list = skmEl('skm-list');
      if (list) list.querySelectorAll('.skm-item').forEach(function (el) {
        el.classList.toggle('skm-item-active', el.getAttribute('data-skm-name') === name);
      });
    }).catch(function (e) { shellToast('读取失败：' + ((e && e.message) || e)); });
  }

  function updateSkmButtons() {
    var hasSel = !!skmSelected;
    var saveBtn = skmEl('skm-save');
    var delBtn = skmEl('skm-delete');
    var projBtn = skmEl('skm-toggle-project');
    var globBtn = skmEl('skm-toggle-global');
    var verBtn = skmEl('skm-versions');
    var content = skmEl('skm-content');
    var nameInput = skmEl('skm-name');
    if (saveBtn) saveBtn.classList.toggle('skm-hidden', !hasSel);
    if (delBtn) delBtn.classList.toggle('skm-hidden', !hasSel);
    if (verBtn) verBtn.classList.toggle('skm-hidden', !hasSel);
    if (!hasSel) { skmVersions = []; skmVersionsOpen = false; renderSkillVersions(); }
    if (projBtn) {
      projBtn.classList.toggle('skm-hidden', !hasSel);
      if (hasSel) projBtn.textContent = (skmEnabled.indexOf(skmSelected) !== -1) ? '本项目禁用' : '本项目启用';
    }
    if (globBtn) {
      globBtn.classList.toggle('skm-hidden', !hasSel);
      if (hasSel) globBtn.textContent = (skmGlobal.indexOf(skmSelected) !== -1) ? '取消全局启用' : '全局启用';
    }
    if (!hasSel) {
      if (content) content.value = '';
      if (nameInput) { nameInput.classList.remove('skm-hidden'); nameInput.value = ''; }
    }
  }

  // ===== 技能版本历史（面板内展开的小区域） =====
  function fmtSkmTime(ms) {
    if (!ms) return '';
    try {
      var d = new Date(ms);
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    } catch (_) { return ''; }
  }

  function renderSkillVersions() {
    var box = skmEl('skm-versions-box');
    if (!box) return;
    if (!skmSelected || !skmVersionsOpen) { box.classList.add('skm-hidden'); box.innerHTML = ''; return; }
    box.classList.remove('skm-hidden');
    if (!skmVersions.length) { box.innerHTML = '<div class="swm-empty">暂无历史版本</div>'; return; }
    box.innerHTML = skmVersions.map(function (v) {
      var meta = fmtSkmTime(v.mtime) + ' · ' + (v.summary || '（无内容摘要）');
      return '<div class="skm-version-item">' +
        '<span class="skm-version-meta' + (v.active ? ' skm-version-active' : '') + '" title="' + skmEsc(meta) + '">' +
          skmEsc(meta) + (v.active ? ' （当前）' : '') +
        '</span>' +
        '<button type="button" class="swm-btn skm-version-btn" data-skm-version="' + skmEsc(v.version) + '"' + (v.active ? ' disabled' : '') + '>回退</button>' +
      '</div>';
    }).join('');
    box.querySelectorAll('[data-skm-version]').forEach(function (el) {
      el.addEventListener('click', function () { restoreShellSkillVersion(el.getAttribute('data-skm-version')); });
    });
  }

  function toggleShellSkillVersions() {
    var api = window.shellAPI;
    if (!skmSelected) { shellToast('请先选择一个技能'); return; }
    if (skmVersionsOpen) { skmVersionsOpen = false; renderSkillVersions(); return; }
    if (!api || !api.knowledgeVersionList) { shellToast('当前环境不支持版本历史'); return; }
    api.knowledgeVersionList(skmSelected).then(function (res) {
      skmVersions = (res && res.success && res.versions) || [];
      skmVersionsOpen = true;
      renderSkillVersions();
      if (res && !res.success) shellToast(res.error || '读取版本失败');
    }).catch(function (e) { shellToast('读取版本失败：' + ((e && e.message) || e)); });
  }

  function restoreShellSkillVersion(version) {
    var api = window.shellAPI;
    if (!skmSelected || !api || !api.knowledgeVersionRestore) return;
    if (!window.confirm('确定回退技能「' + skmSelected + '」到版本 ' + version + '？当前正文将被覆盖。')) return;
    var name = skmSelected;
    api.knowledgeVersionRestore(name, version).then(function (r) {
      if (r && r.success) {
        shellToast('已回退到版本 ' + version);
        selectShellKnowledge(name);
        toggleShellSkillVersionsReload(name);
      } else {
        shellToast((r && r.error) || '回退失败');
      }
    }).catch(function (e) { shellToast('回退失败：' + ((e && e.message) || e)); });
  }

  // 回退后刷新版本列表（保持展开）
  function toggleShellSkillVersionsReload(name) {
    var api = window.shellAPI;
    if (!api || !api.knowledgeVersionList) return;
    api.knowledgeVersionList(name).then(function (res) {
      skmVersions = (res && res.success && res.versions) || [];
      skmVersionsOpen = true;
      renderSkillVersions();
    }).catch(function () {});
  }

  function loadShellPreferences() {
    var api = window.shellAPI;
    var pref = skmEl('skm-pref');
    if (!api || !api.preferenceRead || !pref) return;
    api.preferenceRead().then(function (res) {
      if (res && res.success) pref.value = res.content || '';
    }).catch(function () {});
  }

  function saveShellPreferences() {
    var api = window.shellAPI;
    var pref = skmEl('skm-pref');
    if (!api || !api.preferenceSave) return;
    api.preferenceSave(pref ? pref.value : '').then(function (r) {
      shellToast(r && r.success ? '全局偏好已保存' : ((r && r.error) || '保存失败'));
    }).catch(function (e) { shellToast('保存失败：' + ((e && e.message) || e)); });
  }

  function createShellKnowledge() {
    var api = window.shellAPI;
    var nameInput = skmEl('skm-name');
    var content = skmEl('skm-content');
    if (skmSelected) {
      // 进入新建态
      skmSelected = null;
      updateSkmButtons();
      if (nameInput) { nameInput.classList.remove('skm-hidden'); nameInput.value = ''; nameInput.focus(); }
      if (content) { content.value = ''; content.focus(); }
      shellToast('请输入技能名与正文，再次点击「新建技能」提交');
      return;
    }
    var name = nameInput ? nameInput.value.trim() : '';
    if (!name) { shellToast('请输入技能名'); if (nameInput) nameInput.focus(); return; }
    if (!api || !api.knowledgeCreate) return;
    api.knowledgeCreate(name, content ? content.value : '', {}).then(function (r) {
      if (r && r.success) {
        shellToast('技能已创建');
        renderShellKnowledge();
        selectShellKnowledge(name);
      } else {
        shellToast((r && r.error) || '创建失败');
      }
    }).catch(function (e) { shellToast('创建失败：' + ((e && e.message) || e)); });
  }

  function saveShellKnowledge() {
    var api = window.shellAPI;
    if (!skmSelected) { shellToast('请先选择一个技能'); return; }
    var content = skmEl('skm-content');
    if (!api || !api.knowledgeSave) return;
    api.knowledgeSave(skmSelected, content ? content.value : '').then(function (r) {
      shellToast(r && r.success ? '技能已保存' : ((r && r.error) || '保存失败'));
    }).catch(function (e) { shellToast('保存失败：' + ((e && e.message) || e)); });
  }

  function deleteShellKnowledge() {
    var api = window.shellAPI;
    if (!skmSelected || !api || !api.knowledgeDelete) return;
    if (!window.confirm('确定删除技能「' + skmSelected + '」？此操作不可恢复。')) return;
    var name = skmSelected;
    api.knowledgeDelete(name).then(function (r) {
      if (r && r.success) { shellToast('已删除'); skmSelected = null; updateSkmButtons(); renderShellKnowledge(); }
      else shellToast((r && r.error) || '删除失败');
    }).catch(function (e) { shellToast('删除失败：' + ((e && e.message) || e)); });
  }

  function toggleShellKnowledgeProject() {
    var api = window.shellAPI;
    if (!skmSelected || !api) return;
    var on = skmEnabled.indexOf(skmSelected) !== -1;
    var dir = skmActiveProjectDir();
    var op = on ? api.knowledgeDisable(skmSelected, dir) : api.knowledgeEnable(skmSelected, dir);
    Promise.resolve(op).then(function (r) {
      if (r && r.success) shellToast(on ? '已在本项目禁用' : '已在本项目启用');
      else shellToast((r && r.error) || '操作失败');
      renderShellKnowledge();
    }).catch(function (e) { shellToast('操作失败：' + ((e && e.message) || e)); });
  }

  function toggleShellKnowledgeGlobal() {
    var api = window.shellAPI;
    if (!skmSelected || !api) return;
    var on = skmGlobal.indexOf(skmSelected) !== -1;
    var op = on ? api.knowledgeDisableGlobal(skmSelected) : api.knowledgeEnableGlobal(skmSelected);
    Promise.resolve(op).then(function (r) {
      if (r && r.success) shellToast(on ? '已取消全局启用' : '已全局启用（所有项目生效）');
      else shellToast((r && r.error) || '操作失败');
      renderShellKnowledge();
    }).catch(function (e) { shellToast('操作失败：' + ((e && e.message) || e)); });
  }

  (function bindShellKnowledge() {
    var btn = document.getElementById('rb-btn-knowledge');
    if (btn) btn.addEventListener('click', function () { skmIsOpen() ? skmClose() : skmOpen(); });
    var closeBtn = skmEl('skm-close');
    if (closeBtn) closeBtn.addEventListener('click', skmClose);
    var refreshBtn = skmEl('skm-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', renderShellKnowledge);
    var saveBtn = skmEl('skm-save');
    if (saveBtn) saveBtn.addEventListener('click', saveShellKnowledge);
    var verBtn = skmEl('skm-versions');
    if (verBtn) verBtn.addEventListener('click', toggleShellSkillVersions);
    var createBtn = skmEl('skm-create');
    if (createBtn) createBtn.addEventListener('click', createShellKnowledge);
    var delBtn = skmEl('skm-delete');
    if (delBtn) delBtn.addEventListener('click', deleteShellKnowledge);
    var projBtn = skmEl('skm-toggle-project');
    if (projBtn) projBtn.addEventListener('click', toggleShellKnowledgeProject);
    var globBtn = skmEl('skm-toggle-global');
    if (globBtn) globBtn.addEventListener('click', toggleShellKnowledgeGlobal);
    var prefSaveBtn = skmEl('skm-pref-save');
    if (prefSaveBtn) prefSaveBtn.addEventListener('click', saveShellPreferences);
    var mask = skmEl('skm-mask');
    if (mask) mask.addEventListener('click', function (e) { if (e.target === mask) skmClose(); });
    // 拖拽
    var header = skmEl('skm-header');
    var panel = skmEl('skm-panel');
    if (header && panel) {
      var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
      header.addEventListener('mousedown', function (e) {
        if (e.target && e.target.closest && e.target.closest('button')) return;
        dragging = true; sx = e.clientX; sy = e.clientY; ox = panel._sx || 0; oy = panel._sy || 0; e.preventDefault();
      });
      document.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        panel._sx = ox + (e.clientX - sx); panel._sy = oy + (e.clientY - sy);
        panel.style.transform = 'translate(' + panel._sx + 'px,' + panel._sy + 'px)';
      });
      document.addEventListener('mouseup', function () { dragging = false; });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && skmIsOpen()) skmClose();
    });
  })();

  // ===== 全局设置弹窗（壳层级）：设置作用于所有标签页 =====
  // 设计：
  //  - localStorage 类设置（通知/重试/工具循环看门狗/生命监护显示）以壳层 localStorage 为唯一真源；
  //    保存后经主进程广播 'settings-changed' → webview preload 写入各自 localStorage；新标签 dom-ready 时注入。
  //  - 主进程类设置（watchdog/curator/evolution/policy 全局）本就全局，壳层调用相同 IPC 即可。
  var SSM_LOCAL_KEYS = {
    notify: 'tokfree-notify-enabled',
    retry: 'tokfree-retry-enabled',
    retryCount: 'tokfree-retry-count',
    wdTimeout: 'tokfree-xhr-idle-timeout',
    guard: 'tokfree-guard-enabled'
  };

  function ssmEl(id) { return document.getElementById(id); }
  function ssmGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } }

  function ssmIsOpen() {
    var mask = ssmEl('ssm-mask');
    return !!(mask && !mask.classList.contains('swm-hidden'));
  }

  // 汇总当前壳层 localStorage 类设置（供广播/注入）
  function collectShellLocalSettings() {
    var map = {};
    map[SSM_LOCAL_KEYS.notify] = ssmGet(SSM_LOCAL_KEYS.notify, '1');
    map[SSM_LOCAL_KEYS.retry] = ssmGet(SSM_LOCAL_KEYS.retry, '1');
    map[SSM_LOCAL_KEYS.retryCount] = ssmGet(SSM_LOCAL_KEYS.retryCount, '10');
    map[SSM_LOCAL_KEYS.wdTimeout] = ssmGet(SSM_LOCAL_KEYS.wdTimeout, '300000');
    map[SSM_LOCAL_KEYS.guard] = ssmGet(SSM_LOCAL_KEYS.guard, '1');
    return map;
  }

  // 把壳层 localStorage 类设置注入指定 webview（新标签 dom-ready 时用；不广播避免风暴）
  function applyShellSettingsToWebview(wv) {
    if (!wv || typeof wv.executeJavaScript !== 'function') return;
    var map = collectShellLocalSettings();
    var code = '(function(){var m=' + JSON.stringify(map) + ';' +
      'try{for(var k in m){if(Object.prototype.hasOwnProperty.call(m,k))localStorage.setItem(k,String(m[k]));}}catch(e){}' +
      'return true;})()';
    try { wv.executeJavaScript(code, true); } catch (_) {}
  }

  // 广播 localStorage 类设置到所有 webview（保存后调用）
  function broadcastShellLocalSettings() {
    if (window.shellAPI && window.shellAPI.broadcastSettings) {
      try { window.shellAPI.broadcastSettings({ local: collectShellLocalSettings() }); } catch (_) {}
    }
  }

  var ssmPolicyMode = 'act';
  var ssmPolicyTrust = false;

  function renderSsmPolicyMode() {
    var btn = ssmEl('ssm-policy-mode');
    if (btn) {
      var isPlan = ssmPolicyMode === 'plan';
      btn.textContent = '模式：' + (isPlan ? 'Plan' : 'Act') + '（点击切 ' + (isPlan ? 'Act' : 'Plan') + '）';
    }
    var chk = ssmEl('ssm-policy-trust');
    if (chk) chk.checked = ssmPolicyTrust;
  }

  function loadShellSettings() {
    var api = window.shellAPI || {};
    // localStorage 类设置
    var notifyEl = ssmEl('ssm-set-notify');
    var retryEl = ssmEl('ssm-set-retry');
    var retryCntEl = ssmEl('ssm-set-retry-count');
    var wdTimeoutEl = ssmEl('ssm-set-wd-timeout');
    var guardEl = ssmEl('ssm-set-guard');
    if (notifyEl) notifyEl.checked = ssmGet(SSM_LOCAL_KEYS.notify, '1') === '1';
    if (retryEl) retryEl.checked = ssmGet(SSM_LOCAL_KEYS.retry, '1') === '1';
    if (retryCntEl) retryCntEl.value = ssmGet(SSM_LOCAL_KEYS.retryCount, '10');
    if (wdTimeoutEl) wdTimeoutEl.value = Math.round(parseInt(ssmGet(SSM_LOCAL_KEYS.wdTimeout, '300000'), 10) / 1000) || 300;
    if (guardEl) guardEl.checked = ssmGet(SSM_LOCAL_KEYS.guard, '1') === '1';
    // 生命监护真实状态从主进程读
    try {
      if (api.shellWatchdogGetConfig && guardEl) {
        api.shellWatchdogGetConfig().then(function (r) {
          if (r && r.success && r.config) guardEl.checked = !!r.config.enabled;
        }).catch(function () {});
      }
    } catch (_) {}
    // 工具模式（全局）
    try {
      if (api.shellPolicyGetGlobal) {
        api.shellPolicyGetGlobal().then(function (res) {
          var p = (res && res.success && res.policy) || (res && res.policy) || {};
          ssmPolicyMode = p.mode === 'plan' ? 'plan' : 'act';
          ssmPolicyTrust = p.confirmDangerous === false;
          renderSsmPolicyMode();
        }).catch(function () { renderSsmPolicyMode(); });
      } else { renderSsmPolicyMode(); }
    } catch (_) { renderSsmPolicyMode(); }
    // 引导者
    try {
      if (api.shellCuratorGetConfig) {
        api.shellCuratorGetConfig().then(function (r) {
          if (!r || !r.success || !r.status) return;
          var c = r.status.config || {};
          var col = c.collect || {};
          var setChk = function (id, v) { var el = ssmEl(id); if (el) el.checked = !!v; };
          var setVal = function (id, v) { var el = ssmEl(id); if (el && v != null) el.value = v; };
          setChk('ssm-set-curator', c.enabled);
          setVal('ssm-set-curator-idle', c.idleMinutes);
          setVal('ssm-set-curator-gap', c.minIntervalMinutes);
          setVal('ssm-set-curator-props', c.maxProposals);
          var pe = ssmEl('ssm-set-curator-prompt');
          if (pe) pe.value = c.briefPrompt || '';
          setChk('ssm-cur-col-git', col.git);
          setChk('ssm-cur-col-todos', col.todos);
          setChk('ssm-cur-col-lessons', col.lessons);
          setChk('ssm-cur-col-skills', col.skills);
          setChk('ssm-cur-col-goals', col.goals);
          var hint = ssmEl('ssm-curator-hint');
          if (hint) hint.textContent = r.status.idle ? '当前：系统空闲中' : '当前：系统忙碌中';
        }).catch(function () {});
      }
    } catch (_) {}
    // 定时任务
    renderScheduledTasks();
    // 自进化飞轮总开关
    try {
      if (api.shellEvolutionGetConfig) {
        api.shellEvolutionGetConfig().then(function (r) {
          if (!r || !r.success || !r.config) return;
          var el = ssmEl('ssm-set-evolution');
          if (el) el.checked = !!r.config.enabled;
        }).catch(function () {});
      }
    } catch (_) {}
    // 本地 OpenAI 兼容 API：读配置 + 运行状态
    try {
      if (api.apiServerGet) {
        api.apiServerGet().then(function (r) {
          if (!r || !r.success) return;
          var cfg = r.config || {};
          var enEl = ssmEl('ssm-set-apiserver');
          var portEl = ssmEl('ssm-set-apiserver-port');
          if (enEl) enEl.checked = !!cfg.enabled;
          if (portEl && cfg.port) portEl.value = cfg.port;
          var st = r.status || {};
          var stEl = ssmEl('ssm-apiserver-status');
          if (stEl) stEl.textContent = st.running
            ? ('已启动 http://' + (st.host || '127.0.0.1') + ':' + (st.port || cfg.port) + '/v1')
            : '未启用';
        }).catch(function () {});
      }
    } catch (_) {}
  }

  // ===== 定时任务（用户可管理的轻量定时注入） =====
  function fmtStMeta(t) {
    var parts = [];
    parts.push(t.enabled ? '启用' : '停用');
    if (t.type === 'once') {
      try { parts.push('一次性 ' + new Date(t.atMs).toLocaleString()); } catch (_) { parts.push('一次性'); }
    } else {
      parts.push('每 ' + t.intervalMinutes + ' 分钟');
    }
    parts.push('已跑 ' + (t.runCount || 0) + ' 次');
    return parts.join(' · ');
  }
  function renderScheduledTasks() {
    fillStProfileOptions();
    var box = ssmEl('ssm-st-list');
    if (!box) return;
    var api = window.shellAPI || {};
    if (!api.shellScheduledTaskList) return;
    api.shellScheduledTaskList().then(function (r) {
      if (!r || !r.success) { box.innerHTML = '<span class="ssm-hint">加载失败</span>'; return; }
      var list = (r.tasks || []);
      if (!list.length) { box.innerHTML = '<span class="ssm-hint">暂无定时任务</span>'; return; }
      box.innerHTML = '';
      list.forEach(function (t) {
        var item = document.createElement('div');
        item.className = 'ssm-st-item';
        var name = document.createElement('span');
        name.className = 'ssm-st-name';
        name.textContent = t.name || t.id;
        var meta = document.createElement('span');
        meta.className = 'ssm-st-meta';
        meta.textContent = fmtStMeta(t);
        var tg = document.createElement('button');
        tg.className = 'swm-btn';
        tg.textContent = t.enabled ? '停用' : '启用';
        tg.addEventListener('click', function () {
          api.shellScheduledTaskToggle(t.id, !t.enabled).then(function () { renderScheduledTasks(); }).catch(function () {});
        });
        var del = document.createElement('button');
        del.className = 'swm-btn';
        del.textContent = '删除';
        del.addEventListener('click', function () {
          api.shellScheduledTaskRemove(t.id).then(function () { renderScheduledTasks(); }).catch(function () {});
        });
        item.appendChild(name);
        item.appendChild(meta);
        item.appendChild(tg);
        item.appendChild(del);
        box.appendChild(item);
      });
    }).catch(function () { box.innerHTML = '<span class="ssm-hint">加载失败</span>'; });
  }
  function syncStTypeRows() {
    var sel = ssmEl('ssm-st-type');
    var onceRow = ssmEl('ssm-st-once-row');
    var intRow = ssmEl('ssm-st-interval-row');
    var isOnce = !sel || sel.value === 'once';
    if (onceRow) onceRow.style.display = isOnce ? '' : 'none';
    if (intRow) intRow.style.display = isOnce ? 'none' : '';
  }

  // 填充定时任务「目标窗口」下拉：默认「主窗口（默认）」+ 各窗口 profile
  function fillStProfileOptions() {
    var sel = ssmEl('ssm-st-profile');
    if (!sel) return;
    if (!window.shellAPI || !window.shellAPI.listProfiles) return;
    var cur = sel.value;
    var profilesP = window.shellAPI.listProfiles().catch(function () { return null; });
    var providerP = (window.shellAPI.listProviders ? window.shellAPI.listProviders() : Promise.resolve(null))
      .catch(function () { return null; });
    Promise.all([profilesP, providerP]).then(function (arr) {
      var pres = arr[0], pvres = arr[1];
      var profiles = (pres && pres.success && pres.profiles) ? pres.profiles : [];
      var providerMap = {};
      if (pvres && pvres.success && pvres.providers) {
        pvres.providers.forEach(function (p) { providerMap[p.id] = p.name; });
      }
      var html = '<option value="">主窗口（默认）</option>';
      profiles.forEach(function (p) {
        var tag = providerMap[p.providerId] || p.providerId || p.id;
        html += '<option value="' + attrEsc(p.id) + '">' + swmEsc((p.name || p.id) + ' (' + tag + ')') + '</option>';
      });
      sel.innerHTML = html;
      if (cur) sel.value = cur;
    }).catch(function () {});
  }

  function saveShellSettings() {
    var api = window.shellAPI || {};
    var set = function (k, v) { try { localStorage.setItem(k, v); } catch (_) {} };
    var notifyEl = ssmEl('ssm-set-notify');
    var retryEl = ssmEl('ssm-set-retry');
    var retryCntEl = ssmEl('ssm-set-retry-count');
    var wdTimeoutEl = ssmEl('ssm-set-wd-timeout');
    var guardEl = ssmEl('ssm-set-guard');
    if (notifyEl) set(SSM_LOCAL_KEYS.notify, notifyEl.checked ? '1' : '0');
    if (retryEl) set(SSM_LOCAL_KEYS.retry, retryEl.checked ? '1' : '0');
    if (retryCntEl) set(SSM_LOCAL_KEYS.retryCount, String(parseInt(retryCntEl.value, 10) || 0));
    if (wdTimeoutEl) set(SSM_LOCAL_KEYS.wdTimeout, String((parseInt(wdTimeoutEl.value, 10) || 0) * 1000));
    if (guardEl) {
      set(SSM_LOCAL_KEYS.guard, guardEl.checked ? '1' : '0');
      try { if (api.shellWatchdogSetEnabled) api.shellWatchdogSetEnabled(guardEl.checked); } catch (_) {}
    }
    // 引导者（Curator）
    try {
      if (api.shellCuratorSetConfig) {
        var getChk = function (id) { var el = ssmEl(id); return el ? el.checked : false; };
        var getNum = function (id, d) { var el = ssmEl(id); var v = el ? parseInt(el.value, 10) : NaN; return Number.isFinite(v) ? v : d; };
        var pe = ssmEl('ssm-set-curator-prompt');
        api.shellCuratorSetConfig({
          enabled: getChk('ssm-set-curator'),
          idleMinutes: getNum('ssm-set-curator-idle', 30),
          minIntervalMinutes: getNum('ssm-set-curator-gap', 60),
          maxProposals: getNum('ssm-set-curator-props', 3),
          briefPrompt: pe ? pe.value : '',
          collect: {
            git: getChk('ssm-cur-col-git'),
            todos: getChk('ssm-cur-col-todos'),
            lessons: getChk('ssm-cur-col-lessons'),
            skills: getChk('ssm-cur-col-skills'),
            goals: getChk('ssm-cur-col-goals')
          }
        }).catch(function () {});
      }
    } catch (_) {}
    // 自进化飞轮总开关
    try {
      if (api.shellEvolutionSetConfig) {
        var evEl = ssmEl('ssm-set-evolution');
        api.shellEvolutionSetConfig({ enabled: evEl ? evEl.checked : false }).catch(function () {});
      }
    } catch (_) {}
    // 本地 OpenAI 兼容 API：写配置并起停服务
    try {
      if (api.apiServerSet) {
        var apiEnEl = ssmEl('ssm-set-apiserver');
        var apiPortEl = ssmEl('ssm-set-apiserver-port');
        var apiPortVal = apiPortEl ? parseInt(apiPortEl.value, 10) : NaN;
        var apiPatch = { enabled: apiEnEl ? apiEnEl.checked : false };
        if (Number.isFinite(apiPortVal) && apiPortVal > 0) apiPatch.port = apiPortVal;
        api.apiServerSet(apiPatch).then(function (r) {
          if (!r || !r.success) { shellToast('API 服务设置失败：' + ((r && r.error) || '未知'), 2600); return; }
          var st = r.status || {};
          var stEl = ssmEl('ssm-apiserver-status');
          if (stEl) stEl.textContent = st.running
            ? ('已启动 http://' + (st.host || '127.0.0.1') + ':' + (st.port || apiPatch.port) + '/v1')
            : '未启用';
        }).catch(function (e) { shellToast('API 服务设置异常：' + ((e && e.message) || e), 2600); });
      }
    } catch (_) {}
    // 广播 localStorage 类设置到所有 webview（立即生效）
    broadcastShellLocalSettings();
    shellToast('设置已保存（作用于所有标签页，部分需重启生效）', 2600);
  }

  function ssmOpen() {
    var mask = ssmEl('ssm-mask');
    if (!mask) return;
    mask.classList.remove('swm-hidden');
    loadShellSettings();
  }
  function ssmClose() {
    var mask = ssmEl('ssm-mask');
    if (mask) mask.classList.add('swm-hidden');
  }

  (function bindShellSettings() {
    var mask = ssmEl('ssm-mask');
    if (!mask) return;
    var closeBtn = ssmEl('ssm-close');
    if (closeBtn) closeBtn.addEventListener('click', ssmClose);
    var saveBtn = ssmEl('ssm-save');
    if (saveBtn) saveBtn.addEventListener('click', saveShellSettings);
    mask.addEventListener('click', function (e) { if (e.target === mask) ssmClose(); });

    // 工具模式（全局）切换
    var modeBtn = ssmEl('ssm-policy-mode');
    if (modeBtn) modeBtn.addEventListener('click', function () {
      var api = window.shellAPI || {};
      var next = ssmPolicyMode === 'plan' ? 'act' : 'plan';
      if (!api.shellPolicySetGlobalMode) return;
      api.shellPolicySetGlobalMode(next).then(function (res) {
        if (res && res.success === false) { shellToast('切换失败：' + (res.error || '未知')); return; }
        ssmPolicyMode = next;
        renderSsmPolicyMode();
        shellToast('已切换全局模式到 ' + (next === 'plan' ? 'Plan（只读规划）' : 'Act（正常执行）') + '（影响所有标签页）', 2600);
      }).catch(function (e) { shellToast('切换失败：' + ((e && e.message) || e)); });
    });
    // 信任模式（全局）
    var trustChk = ssmEl('ssm-policy-trust');
    if (trustChk) trustChk.addEventListener('change', function () {
      var api = window.shellAPI || {};
      var trustChecked = !!trustChk.checked;
      var confirmDangerous = !trustChecked;
      if (!api.shellPolicySetGlobalTrust) return;
      api.shellPolicySetGlobalTrust(confirmDangerous).then(function (res) {
        if (res && res.success === false) { shellToast('保存失败：' + (res.error || '未知')); return; }
        ssmPolicyTrust = trustChecked;
        shellToast(trustChecked ? '全局信任模式：危险操作免确认' : '全局信任模式关闭：危险操作需确认', 2600);
      }).catch(function (e) { shellToast('保存失败：' + ((e && e.message) || e)); });
    });
    // 引导者：立即巡检一次
    var curNowBtn = ssmEl('ssm-btn-curator-now');
    if (curNowBtn) curNowBtn.addEventListener('click', function () {
      var api = window.shellAPI || {};
      var hint = ssmEl('ssm-curator-hint');
      if (!api.shellCuratorTriggerNow) return;
      if (hint) hint.textContent = '正在采集并注入…';
      api.shellCuratorTriggerNow().then(function (r) {
        if (r && r.success) { if (hint) hint.textContent = '已注入战略巡检简报'; shellToast('已发起战略巡检', 2500); }
        else { if (hint) hint.textContent = '失败：' + ((r && r.error) || '未知'); shellToast('巡检失败：' + ((r && r.error) || '未知'), 3000); }
      }).catch(function (e) { if (hint) hint.textContent = '出错：' + ((e && e.message) || e); });
    });
    // 定时任务：类型切换 + 创建
    var stTypeSel = ssmEl('ssm-st-type');
    if (stTypeSel) stTypeSel.addEventListener('change', syncStTypeRows);
    syncStTypeRows();
    var stCreateBtn = ssmEl('ssm-btn-st-create');
    if (stCreateBtn) stCreateBtn.addEventListener('click', function () {
      var api = window.shellAPI || {};
      var hint = ssmEl('ssm-st-hint');
      if (!api.shellScheduledTaskCreate) return;
      var nameEl = ssmEl('ssm-st-name');
      var promptEl = ssmEl('ssm-st-prompt');
      var typeEl = ssmEl('ssm-st-type');
      var atEl = ssmEl('ssm-st-at');
      var intEl = ssmEl('ssm-st-interval');
      var profEl = ssmEl('ssm-st-profile');
      var prompt = promptEl ? promptEl.value : '';
      if (!prompt.trim()) { if (hint) hint.textContent = '请填写 prompt 内容'; return; }
      var opts = {
        name: nameEl ? nameEl.value : '',
        prompt: prompt,
        type: typeEl ? typeEl.value : 'once',
        profileId: profEl ? profEl.value.trim() : ''
      };
      if (opts.type === 'once') {
        var at = atEl && atEl.value ? Date.parse(atEl.value) : NaN;
        if (!Number.isFinite(at)) { if (hint) hint.textContent = '请填写有效的执行时间'; return; }
        opts.atMs = at;
      } else {
        opts.intervalMinutes = intEl ? (parseInt(intEl.value, 10) || 30) : 30;
      }
      api.shellScheduledTaskCreate(opts).then(function (r) {
        if (r && r.success) {
          if (hint) hint.textContent = '已创建';
          if (nameEl) nameEl.value = '';
          if (promptEl) promptEl.value = '';
          renderScheduledTasks();
        } else { if (hint) hint.textContent = '创建失败：' + ((r && r.error) || '未知'); }
      }).catch(function (e) { if (hint) hint.textContent = '创建出错：' + ((e && e.message) || e); });
    });

    // 沉浸式交流：在活动标签执行（复用覆盖层按钮）
    var imBtn = ssmEl('ssm-btn-immersive');
    if (imBtn) imBtn.addEventListener('click', function () {
      execInActive('var b=document.getElementById("tokfree-btn-immersive"); if(b)b.click(); true')
        .then(function () { shellToast('已发送沉浸式交流提示', 2200); })
        .catch(function () { shellToast('当前标签不可用', 2200); });
    });
    // 磁盘清理
    var fmtMB = function (bytes) { return (bytes / 1024 / 1024).toFixed(1) + ' MB'; };
    var refreshDisk = function () {
      var api = window.shellAPI || {};
      var el = ssmEl('ssm-disk-usage');
      if (!el || !api.cleanupUsage) return;
      api.cleanupUsage().then(function (r) {
        if (r && r.success && r.usage) {
          var u = r.usage;
          el.textContent = '总计 ' + fmtMB(u.total) + '（缓存 ' + fmtMB(u.partitions) + '、截图 ' + fmtMB(u.screenshots) + '、日志 ' + fmtMB(u.logs) + '）';
        } else { el.textContent = '占用查询失败'; }
      }).catch(function () { el.textContent = '占用查询失败'; });
    };
    var ccBtn = ssmEl('ssm-btn-cleanup-cache');
    if (ccBtn) ccBtn.addEventListener('click', function () {
      var api = window.shellAPI || {};
      if (!api.cleanupCache) return;
      api.cleanupCache().then(function (r) {
        if (r && r.success) { shellToast('缓存已清理，释放 ' + fmtMB((r.result && r.result.freedBytes) || 0), 3000); refreshDisk(); }
        else shellToast('清理失败：' + ((r && r.error) || '未知'), 3000);
      }).catch(function (e) { shellToast('清理失败：' + ((e && e.message) || e), 3000); });
    });
    var caBtn = ssmEl('ssm-btn-cleanup-all');
    if (caBtn) caBtn.addEventListener('click', function () {
      var api = window.shellAPI || {};
      if (!api.cleanupAll) return;
      api.cleanupAll().then(function (r) {
        if (r && r.success) {
          var res = r.result || {};
          shellToast('已清理：孤儿 ' + (res.partitions || 0) + ' 个、截图 ' + (res.screenshots || 0) + ' 张，释放 ' + fmtMB(res.freedBytes || 0), 4000);
          refreshDisk();
        } else shellToast('清理失败：' + ((r && r.error) || '未知'), 3000);
      }).catch(function (e) { shellToast('清理失败：' + ((e && e.message) || e), 3000); });
    });
    // 更新日志：打开多版本标签页弹窗（与左下角「日志」同一入口）
    var changelogBtn = ssmEl('ssm-btn-changelog');
    if (changelogBtn) changelogBtn.addEventListener('click', function () {
      try {
        if (window.shellAPI && window.shellAPI.openChangelog) {
          window.shellAPI.openChangelog().then(function (r) {
            if (r && r.success === false) shellToast('打开失败：' + (r.error || '未知'), 3000);
          }).catch(function (e) { shellToast('打开失败：' + ((e && e.message) || e), 3000); });
        } else {
          shellToast('当前环境不支持', 3000);
        }
      } catch (e) { shellToast('调用失败：' + ((e && e.message) || e), 3000); }
    });
    // 关于：显示当前版本号
    var aboutVerEl = ssmEl('ssm-about-version');
    if (aboutVerEl && window.shellAPI && window.shellAPI.getShellInfo) {
      window.shellAPI.getShellInfo().then(function (info) {
        if (info && info.version) aboutVerEl.textContent = 'v' + info.version;
      }).catch(function () {});
    }
    // 关于：在活动标签打开覆盖层关于面板（复用现有实现）
    var aboutBtn = ssmEl('ssm-btn-about');
    if (aboutBtn) aboutBtn.addEventListener('click', function () {
      // 先关闭设置抽屉：否则壳层遮罩（z-index 10000）会盖住 webview 内的关于弹窗
      ssmClose();
      execInActive('var b=document.getElementById("tokfree-btn-about"); if(b)b.click(); true').catch(function () {});
    });

    // 拖拽
    var header = ssmEl('ssm-header');
    var panel = ssmEl('ssm-panel');
    if (header && panel) {
      var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
      header.addEventListener('mousedown', function (e) {
        if (e.target && e.target.closest && e.target.closest('button')) return;
        dragging = true; sx = e.clientX; sy = e.clientY; ox = panel._sx || 0; oy = panel._sy || 0; e.preventDefault();
      });
      document.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        panel._sx = ox + (e.clientX - sx); panel._sy = oy + (e.clientY - sy);
        panel.style.transform = 'translate(' + panel._sx + 'px,' + panel._sy + 'px)';
      });
      document.addEventListener('mouseup', function () { dragging = false; });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ssmIsOpen()) ssmClose();
    });
  })();


  // ===== Agent 风格对话视图（WorkBuddy 模式：网页隐藏，只呈现思考/步骤/结果） =====
  var viewToggleBtn = document.getElementById('view-toggle-btn');

  // 视图模式按标签隔离：每个 tab 存自己的 viewMode（默认 'agent'），随 persistTabs 一起持久化。
  function getViewMode() {
    var t = activeId ? findTab(activeId) : null;
    if (t && t.viewMode) return t.viewMode;
    return 'agent';
  }

  function setViewMode(mode) {
    mode = (mode === 'web') ? 'web' : 'agent';
    // 只改当前标签的视图状态，不影响其它标签
    var t = activeId ? findTab(activeId) : null;
    if (t) t.viewMode = mode;
    // 切换视图时清掉「临时露出 webview」状态，避免残留导致 Agent 视图被隐藏
    var cvEl = document.getElementById('chat-view');
    if (cvEl) cvEl.classList.remove('cv-reveal-web');
    webRevealed = false;
    if (window.AgentView) AgentView.setVisible(mode === 'agent');
    if (viewToggleBtn) viewToggleBtn.textContent = (mode === 'agent') ? '查看网页' : 'Agent 界面';
    // 切到 Agent 视图时立即刷新一次，同步最新的 generating 状态（驱动停止按钮显隐）
    if (mode === 'agent' && window.AgentView && window.AgentView.refresh) {
      window.AgentView.refresh(true);
    }
    persistTabs();
  }

  // 登录页强制回退网页视图（登录/验证码必须在网页里操作）；
  // 登录完成后自动回到 Agent 视图（仅限是系统自动切过去的情况）。
  // autoSwitched 按标签记录，避免一个标签的登录态切换串扰到其它标签。
  function notifyLoginState(onLogin) {
    var t = activeId ? findTab(activeId) : null;
    if (onLogin && getViewMode() === 'agent') {
      if (t) t.autoSwitchedToWeb = true;
      setViewMode('web');
    } else if (!onLogin && t && t.autoSwitchedToWeb) {
      t.autoSwitchedToWeb = false;
      setViewMode('agent');
    }
  }

  // ===== API 型平台（api-openai）专属：配置条 + 隐藏「查看网页」 =====
  // providerId 映射：profileId → providerId（由 listProfiles 缓存），据此判断标签是否 API 型平台。
  function getTabProviderId(t) {
    if (!t || !t.profileId) return '';
    return profileProviderMap[t.profileId] || '';
  }
  // 当前标签所属平台的首页地址（拿不到时兜底 DEFAULT_URL，行为与旧逻辑一致）
  function getTabHomeUrl(t) {
    var pid = getTabProviderId(t);
    return (pid && providerHomeUrlMap[pid]) || DEFAULT_URL;
  }
  function isApiProviderTab(t) {
    return getTabProviderId(t) === 'api-openai';
  }

  var providerMapRefreshing = false;
  function refreshProfileProviderMap() {
    if (!window.shellAPI || !window.shellAPI.listProfiles) return Promise.resolve();
    if (providerMapRefreshing) return Promise.resolve();
    providerMapRefreshing = true;
    return window.shellAPI.listProfiles().then(function (res) {
      providerMapRefreshing = false;
      var profiles = (res && res.success && res.profiles) ? res.profiles : (Array.isArray(res) ? res : []);
      var map = {};
      for (var i = 0; i < profiles.length; i++) {
        if (profiles[i] && profiles[i].id) map[profiles[i].id] = profiles[i].providerId || '';
      }
      profileProviderMap = map;
      // 同步缓存 providerId → homeUrl（新建对话时跳对应平台首页）
      if (window.shellAPI && window.shellAPI.listProviders) {
        window.shellAPI.listProviders().then(function (pvres) {
          var plist = (pvres && pvres.success && pvres.providers) ? pvres.providers : [];
          var hmap = {};
          for (var j = 0; j < plist.length; j++) {
            if (plist[j] && plist[j].id) hmap[plist[j].id] = plist[j].homeUrl || '';
          }
          providerHomeUrlMap = hmap;
        }).catch(function () {});
      }
      var at = activeId ? findTab(activeId) : null;
      if (at && isApiProviderTab(at)) applyViewModeForTab(at);
    }).catch(function () { providerMapRefreshing = false; });
  }

  // 保存配置到主进程（防抖），并把配置同步到 api-chat 页面
  var apiCfgSaveTimer = null;
  function scheduleSaveApiConfig(profileId, cfg) {
    if (apiCfgSaveTimer) clearTimeout(apiCfgSaveTimer);
    apiCfgSaveTimer = setTimeout(function () {
      apiCfgSaveTimer = null;
      if (!profileId) return;
      if (window.shellAPI && window.shellAPI.apiConfigSet) {
        window.shellAPI.apiConfigSet(profileId, cfg).catch(function () {});
      }
      syncApiConfigToChat(cfg);
    }, 300);
  }

  function syncApiConfigToChat(cfg) {
    try {
      var code = '(function(){try{if(window.__tokfreeApiChat&&typeof window.__tokfreeApiChat.setConfig==="function"){window.__tokfreeApiChat.setConfig(' +
        JSON.stringify(cfg) + ');return true;}}catch(e){}return false;})()';
      execInActive(code).catch(function () {});
    } catch (_) {}
  }

  function fillModelSelect(current) {
    var sel = document.getElementById('cv-apiconfig-model');
    if (!sel) return;
    current = current || 'auto';
    sel.innerHTML = '';
    var opt = document.createElement('option');
    opt.value = current;
    opt.textContent = current;
    sel.appendChild(opt);
    sel.value = current;
  }

  var apiModelsSeq = 0;
  function loadApiModels(baseUrl, authKey, current) {
    var sel = document.getElementById('cv-apiconfig-model');
    if (!sel || !baseUrl || !window.shellAPI || !window.shellAPI.apiProviderRequest) return;
    var seq = ++apiModelsSeq;
    window.shellAPI.apiProviderRequest({ baseUrl: baseUrl, path: '/models', method: 'GET', authKey: authKey, stream: false }).then(function (res) {
      if (seq !== apiModelsSeq) return;
      if (res && typeof res === 'object' && res.ok === false) return;
      var data = res;
      if (res && typeof res === 'object' && res.data !== undefined) data = res.data;
      var list = null;
      if (Array.isArray(data)) list = data;
      else if (data && Array.isArray(data.data)) list = data.data;
      var ids = [];
      if (list) {
        for (var i = 0; i < list.length; i++) {
          var it = list[i];
          var id = (it && typeof it === 'object') ? it.id : it;
          if (id) ids.push(String(id));
        }
      }
      if (!ids.length) return;
      var prev = sel.value || current || 'auto';
      sel.innerHTML = '';
      for (var j = 0; j < ids.length; j++) {
        var o = document.createElement('option');
        o.value = ids[j];
        o.textContent = ids[j];
        sel.appendChild(o);
      }
      var found = false;
      for (var k = 0; k < sel.options.length; k++) { if (sel.options[k].value === prev) { found = true; break; } }
      if (!found) {
        var oo = document.createElement('option');
        oo.value = prev;
        oo.textContent = prev;
        sel.appendChild(oo);
      }
      sel.value = prev;
    }).catch(function () {});
  }

  var apiConfigLoadSeq = 0;
  function loadApiConfigIntoBar(t) {
    if (!t) return;
    var pid = t.profileId || '';
    if (!pid || !window.shellAPI || !window.shellAPI.apiConfigGet) return;
    var seq = ++apiConfigLoadSeq;
    window.shellAPI.apiConfigGet(pid).then(function (res) {
      if (seq !== apiConfigLoadSeq) return;
      var cfg = (res && res.config) ? res.config : {};
      var baseUrl = cfg.baseUrl || '';
      var authKey = cfg.authKey || '';
      var model = cfg.model || 'auto';
      var image = !!cfg.image;
      var bu = document.getElementById('cv-apiconfig-baseurl');
      var ak = document.getElementById('cv-apiconfig-authkey');
      var im = document.getElementById('cv-apiconfig-image');
      if (bu) bu.value = baseUrl;
      if (ak) ak.value = authKey;
      if (im) im.checked = image;
      fillModelSelect(model);
      syncApiConfigToChat({ baseUrl: baseUrl, authKey: authKey, model: model, image: image });
      loadApiModels(baseUrl, authKey, model);
    }).catch(function () {});
  }

  var apiConfigBound = false;
  function bindApiConfigBarOnce() {
    if (apiConfigBound) return;
    var bar = document.getElementById('cv-apiconfig');
    if (!bar) return;
    apiConfigBound = true;
    var bu = document.getElementById('cv-apiconfig-baseurl');
    var ak = document.getElementById('cv-apiconfig-authkey');
    var sel = document.getElementById('cv-apiconfig-model');
    var im = document.getElementById('cv-apiconfig-image');
    var rf = document.getElementById('cv-apiconfig-refresh');

    function activeProfileId() { var t = activeId ? findTab(activeId) : null; return t ? (t.profileId || '') : ''; }
    function currentCfg() {
      return {
        baseUrl: (bu && bu.value || '').trim(),
        authKey: (ak && ak.value || '').trim(),
        model: (sel && sel.value) || 'auto',
        image: !!(im && im.checked),
      };
    }
    function persist() { var pid = activeProfileId(); if (pid) scheduleSaveApiConfig(pid, currentCfg()); }
    var reloadTimer = null;
    function scheduleReload() {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(function () {
        reloadTimer = null;
        var c = currentCfg();
        loadApiModels(c.baseUrl, c.authKey, c.model);
      }, 500);
    }
    if (bu) bu.addEventListener('input', function () { persist(); scheduleReload(); });
    if (ak) ak.addEventListener('input', function () { persist(); scheduleReload(); });
    if (sel) sel.addEventListener('change', persist);
    if (im) im.addEventListener('change', persist);
    if (rf) rf.addEventListener('click', function () { var c = currentCfg(); loadApiModels(c.baseUrl, c.authKey, c.model); });
  }

  // 发送用户消息：走网页内 overlay 的「补充说明」通道（AI 忙时自动排队，随回执一起发）
  function agentSendText(text) {
    var code =
      '(function(){' +
      // API 型页面（api-chat）：无 TokFree 覆盖层，走壳层桥接接口 __tokfreeApiChat
      'if(window.__tokfreeApiChat&&typeof window.__tokfreeApiChat.send==="function"){' +
      'var aok=window.__tokfreeApiChat.send(' + JSON.stringify(text) + ');' +
      'return {ok:!!aok,api:true};}' +
      'var i=document.getElementById("tokfree-user-input");' +
      'var b=document.getElementById("tokfree-user-send");' +
      'if(!i||!b)return {ok:false};' +
      'i.value=' + JSON.stringify(text) + ';' +
      'b.click();return {ok:true};' +
      '})()';
    return execInActive(code).then(function (r) { return !!(r && r.ok); }).catch(function () { return false; });
  }

  // 壳层轻量提示（附件上传反馈等）
  function shellToast(text, duration) {
    var el = document.getElementById('cv-shell-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cv-shell-toast';
      el.className = 'cv-shell-toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(shellToast._timer);
    shellToast._timer = setTimeout(function () { el.classList.remove('show'); }, duration || 2200);
  }

  // 把本地文件路径作为附件上传到当前活动 webview 的对话
  function attachFilesToActive(paths) {
    var code =
      '(function(){' +
      'var f=window.electronAPI&&window.electronAPI.attachLocalFile;' +
      'if(!f)return Promise.resolve({ok:false,error:"attachLocalFile 不可用"});' +
      'var ps=' + JSON.stringify(paths) + ';' +
      'return Promise.all(ps.map(function(p){' +
      'return Promise.resolve(f(p)).then(function(r){return r||{success:false};},' +
      'function(e){return {success:false,error:(e&&e.message)||String(e)};});' +
      '})).then(function(rs){return {ok:true,results:rs};});' +
      '})()';
    return execInActive(code);
  }

  var attachBtn = document.getElementById('cv-attach');
  if (attachBtn) {
    attachBtn.addEventListener('click', function () {
      if (!window.shellAPI || !window.shellAPI.selectFile) {
        shellToast('附件功能不可用');
        return;
      }
      attachBtn.disabled = true;
      window.shellAPI.selectFile().then(function (r) {
        if (!r || !r.success || !r.paths || !r.paths.length) return null;
        shellToast('正在上传附件…', 3000);
        return attachFilesToActive(r.paths).then(function (res) {
          var results = (res && res.results) || [];
          var okN = 0, failN = 0;
          for (var i = 0; i < results.length; i++) {
            if (results[i] && results[i].success) okN++; else failN++;
          }
          if (okN > 0 && failN === 0) shellToast('已添加 ' + okN + ' 个附件');
          else if (okN > 0) shellToast('已添加 ' + okN + ' 个附件，' + failN + ' 个失败');
          else shellToast('附件上传失败');
          // 需求1b：附件在网页端渲染需时间，多次触发附件同步（pollActiveWebview 驱动 renderAttachments）
          setTimeout(function () {
            if (window.AgentView && getViewMode() === 'agent') window.AgentView.refresh(true);
            pollActiveWebview();
          }, 500);
          setTimeout(function () { pollActiveWebview(); }, 1200);
          setTimeout(function () { pollActiveWebview(); }, 2500);
        });
      }).catch(function () {
        shellToast('附件上传失败');
      }).then(function () { attachBtn.disabled = false; });
    });
  }

  // ===== 「停止生成」按钮：AI 运行中显示，点击后点网页端停止键 =====
  // running 由 pollActiveWebview / applyRightBarFromWeb 的状态轮询驱动（r.running）。
  function syncStopBtn(running) {
    var btn = document.getElementById('cv-stop');
    if (btn) btn.classList.toggle('cv-hidden', !running);
  }

  // 在活动 webview 内查找网页端「停止」按钮并点击。找不到不报错（返回 ok:false）。
  function stopActiveGeneration() {
    var sels = [
      '[aria-label*="停止"]', '[title*="停止"]',
      '[aria-label*="Stop"]', '[aria-label*="stop"]',
      '[title*="Stop"]', '[title*="stop"]'
    ];
    var code =
      '(function(){' +
      'var sels=' + JSON.stringify(sels) + ';' +
      'for(var i=0;i<sels.length;i++){' +
      'var els=document.querySelectorAll(sels[i]);' +
      'for(var j=0;j<els.length;j++){' +
      'var el=els[j];' +
      'if(el && el.offsetWidth>0 && !el.disabled){el.click();return {ok:true};}' +
      '}' +
      '}' +
      'return {ok:false};' +
      '})()';
    return execInActive(code);
  }

  var stopBtn = document.getElementById('cv-stop');
  if (stopBtn) {
    stopBtn.addEventListener('click', function () {
      stopBtn.disabled = true;
      stopActiveGeneration().then(function (r) {
        if (r && r.ok) shellToast('已停止生成');
        else shellToast('当前没有正在生成的任务');
        // 状态轮询会很快刷新按钮显隐；此处也主动同步一次执行态
        setTimeout(function () { pollActiveWebview(); }, 400);
      }).catch(function () {
        shellToast('停止失败：无活动标签');
      }).then(function () { stopBtn.disabled = false; });
    });
  }


  // ===== 「深度思考」开关：与网页端同步，默认开启（每标签独立状态）=====
  // cvDeepThink[tabId] = { on: bool, available: bool }
  var cvDeepThink = {};
  // deepThinkInitDone[tabId] = true 表示该标签已做过「默认开启」判定，之后不再强制
  var deepThinkInitDone = {};

  function renderDeepThinkBtn() {
    var btn = document.getElementById('cv-deepthink');
    if (!btn) return;
    var st = (activeId && cvDeepThink[activeId]) || null;
    if (!st || !st.available) {
      btn.classList.add('cv-hidden');
      btn.classList.remove('on');
      return;
    }
    btn.classList.remove('cv-hidden');
    if (st.on) btn.classList.add('on'); else btn.classList.remove('on');
    btn.title = st.on ? '深度思考：已开启（点击关闭）' : '深度思考：已关闭（点击开启）';
  }

  function syncDeepThinkFromWeb() {
    if (!activeId) { renderDeepThinkBtn(); return; }
    var tid = activeId;
    var code = 'window.electronAPI && window.electronAPI.readDeepThink' +
      ' ? window.electronAPI.readDeepThink()' +
      ' : {available:false}';
    execInActive(code).then(function (r) {
      var st = { available: !!(r && r.available), on: !!(r && r.on) };
      cvDeepThink[tid] = st;
      if (st.available && st.on) {
        // 已是开启态：标记已完成默认开启判定，避免用户关闭后被反复强制打开
        deepThinkInitDone[tid] = true;
      } else if (st.available && !st.on && !deepThinkInitDone[tid]) {
        // 首次发现可用但未开启 → 自动开启一次
        deepThinkInitDone[tid] = true;
        var code2 = 'window.electronAPI && window.electronAPI.setDeepThink' +
          ' ? window.electronAPI.setDeepThink(true)' +
          ' : {ok:false}';
        execInActive(code2).then(function (res) {
          if (res && res.ok) cvDeepThink[tid] = { available: true, on: true };
          if (activeId === tid) renderDeepThinkBtn();
        }).catch(function () {});
      }
      if (activeId === tid) renderDeepThinkBtn();
    }).catch(function () { if (activeId === tid) renderDeepThinkBtn(); });
  }

  (function bindDeepThinkBtn() {
    var btn = document.getElementById('cv-deepthink');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var tid = activeId;
      if (!tid) return;
      var st = cvDeepThink[tid] || { on: false, available: false };
      if (!st.available) { shellToast('当前网页不支持深度思考开关'); return; }
      var next = !st.on;
      // 用户手动操作后，本标签不再自动强制开启
      deepThinkInitDone[tid] = true;
      btn.disabled = true;
      var code = 'window.electronAPI && window.electronAPI.setDeepThink' +
        ' ? window.electronAPI.setDeepThink(' + (next ? 'true' : 'false') + ')' +
        ' : {ok:false}';
      execInActive(code).then(function (r) {
        if (r && r.ok) {
          cvDeepThink[tid] = { available: true, on: next };
          if (activeId === tid) renderDeepThinkBtn();
          shellToast('深度思考已' + (next ? '开启' : '关闭'));
        } else {
          shellToast('切换失败：' + ((r && r.reason) || '未知'));
          syncDeepThinkFromWeb();
        }
      }).catch(function (e) {
        shellToast('切换失败：' + ((e && e.message) || e));
      }).then(function () { btn.disabled = false; });
    });
  })();

  // ===== 每标签独立的工具模式 / 信任模式控件（仅对当前活动标签生效）=====
  var cvPolicyMode = 'act';      // 当前 active 标签的 mode
  var cvPolicyTrust = false;     // 当前 active 标签的信任（=!confirmDangerous）

  function renderCvPolicyBar() {
    var bar = document.getElementById('cv-policy-bar');
    var t = activeId ? findTab(activeId) : null;
    if (bar) bar.classList[t ? 'remove' : 'add']('cv-hidden');
    var modeBtn = document.getElementById('cv-policy-mode');
    if (modeBtn) {
      var isPlan = cvPolicyMode === 'plan';
      modeBtn.textContent = '模式：' + (isPlan ? 'Plan' : 'Act') + '（点击切 ' + (isPlan ? 'Act' : 'Plan') + '）';
    }
    var chk = document.getElementById('cv-policy-trust');
    if (chk) chk.checked = cvPolicyTrust;
  }

  // 读取当前活动标签的策略并刷新控件
  function refreshCvPolicyBar() {
    var t = activeId ? findTab(activeId) : null;
    if (!t || !window.shellAPI || !window.shellAPI.policyGet) { renderCvPolicyBar(); return; }
    window.shellAPI.policyGet(t.profileId || '').then(function (res) {
      // 异步返回时 active 标签可能已切换，避免覆盖新标签的显示
      if (!activeId || (findTab(activeId) !== t)) return;
      var p = (res && res.success && res.policy) || (res && res.policy) || {};
      cvPolicyMode = p.mode === 'plan' ? 'plan' : 'act';
      cvPolicyTrust = p.confirmDangerous === false;
      renderCvPolicyBar();
    }).catch(function () { renderCvPolicyBar(); });
  }

  (function bindCvPolicyBar() {
    var modeBtn = document.getElementById('cv-policy-mode');
    if (modeBtn) {
      modeBtn.addEventListener('click', function () {
        var t = activeId ? findTab(activeId) : null;
        if (!t || !window.shellAPI || !window.shellAPI.policySetMode) return;
        var next = cvPolicyMode === 'plan' ? 'act' : 'plan';
        window.shellAPI.policySetMode(t.profileId || '', next).then(function (res) {
          if (res && res.success === false) { shellToast('切换失败：' + (res.error || '未知')); return; }
          cvPolicyMode = next;
          renderCvPolicyBar();
          shellToast('本标签已切换到 ' + (next === 'plan' ? 'Plan（只读规划）' : 'Act（正常执行）'));
        }).catch(function (e) { shellToast('切换失败：' + (e && e.message || e)); });
      });
    }
    var chk = document.getElementById('cv-policy-trust');
    if (chk) {
      chk.addEventListener('change', function () {
        var t = activeId ? findTab(activeId) : null;
        if (!t || !window.shellAPI || !window.shellAPI.policySetTrust) return;
        var trustChecked = !!chk.checked;
        var confirmDangerous = !trustChecked;
        window.shellAPI.policySetTrust(t.profileId || '', confirmDangerous).then(function (res) {
          if (res && res.success === false) { shellToast('保存失败：' + (res.error || '未知')); return; }
          cvPolicyTrust = trustChecked;
          renderCvPolicyBar();
          shellToast(trustChecked ? '本标签：危险操作免确认' : '本标签：危险操作需确认');
        }).catch(function (e) { shellToast('保存失败：' + (e && e.message || e)); });
      });
    }
    renderCvPolicyBar();
  })();

  // ===== 需求1：壳端输入区支持从系统拖拽文件上传 =====
  // 关键：Electron 33+ 已移除 File.path，必须用 webUtils.getPathForFile（见 shell-preload.js）。
  function dragHasFiles(e) {
    try {
      var dt = e && e.dataTransfer;
      if (!dt) return false;
      var types = dt.types || [];
      for (var i = 0; i < types.length; i++) { if (types[i] === 'Files') return true; }
      return false;
    } catch (_) { return false; }
  }

  function handleDroppedFiles(fileList) {
    if (!fileList || !fileList.length) return;
    var api = window.shellAPI;
    if (!api || typeof api.getPathForFile !== 'function') {
      // 回退：该环境不支持拖拽取路径 → 引导用户点📎（不把异常抛给用户）
      shellToast('该环境不支持拖拽，请点📎选择');
      return;
    }
    var paths = [];
    for (var i = 0; i < fileList.length; i++) {
      var p = '';
      try { p = api.getPathForFile(fileList[i]) || ''; } catch (_) { p = ''; }
      if (p) paths.push(p);
    }
    if (!paths.length) { shellToast('未能获取文件路径，请点📎选择'); return; }
    shellToast('正在上传 ' + paths.length + ' 个附件…', 3000);
    attachFilesToActive(paths).then(function (res) {
      var results = (res && res.results) || [];
      var okN = 0, failN = 0;
      for (var j = 0; j < results.length; j++) {
        if (results[j] && results[j].success) okN++; else failN++;
      }
      if (okN > 0 && failN === 0) shellToast('已添加 ' + okN + ' 个附件');
      else if (okN > 0) shellToast('已添加 ' + okN + ' 个附件，' + failN + ' 个失败');
      else shellToast('附件上传失败');
      // 附件在网页端渲染需要时间，稍后刷新附件 chips
      setTimeout(function () { pollActiveWebview(); }, 800);
      setTimeout(function () { pollActiveWebview(); }, 2500);
    }).catch(function () { shellToast('附件上传失败'); });
  }

  function setupDropZone() {
    var zone = document.getElementById('chat-view');
    var row = document.querySelector('.cv-input-row');
    if (!zone) return;
    var depth = 0;
    function highlight(on) { if (row) row.classList[on ? 'add' : 'remove']('cv-drop-active'); }
    zone.addEventListener('dragenter', function (e) {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      depth++;
      highlight(true);
    });
    zone.addEventListener('dragover', function (e) {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {}
      highlight(true);
    });
    zone.addEventListener('dragleave', function (e) {
      if (!dragHasFiles(e)) return;
      depth--;
      if (depth <= 0) { depth = 0; highlight(false); }
    });
    zone.addEventListener('drop', function (e) {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      highlight(false);
      handleDroppedFiles(e.dataTransfer && e.dataTransfer.files);
    });
    // 全局兜底：仅当拖的是文件时才阻止 Electron 默认行为（避免窗口"打开/导航到该文件"）；
    // 不拦纯文本拖拽，保持 textarea 拖入文本的原生行为。
    document.addEventListener('dragover', function (e) { if (dragHasFiles(e)) { try { e.preventDefault(); } catch (_) {} } });
    document.addEventListener('drop', function (e) { if (dragHasFiles(e)) { try { e.preventDefault(); } catch (_) {} } });
  }
  setupDropZone();

  // ===== 需求2：壳端输入区支持 Ctrl+V 粘贴图片/文件上传 =====
  // cv-input 是壳层 textarea，粘贴的图片/文件来自剪贴板（File 对象，通常无磁盘路径）。
  // 优先用 getPathForFile 取路径（从文件管理器复制的文件可能有）；否则转 base64 →
  // saveTempFile 落盘到系统临时目录 → 得到绝对路径，走现有 attachFilesToActive。
  function collectClipboardFiles(e) {
    var out = [];
    try {
      var dt = e && e.clipboardData;
      if (!dt) return out;
      var fl = dt.files;
      if (fl && fl.length) {
        for (var i = 0; i < fl.length; i++) out.push(fl[i]);
        return out;
      }
      var items = dt.items || [];
      for (var j = 0; j < items.length; j++) {
        if (items[j] && items[j].kind === 'file') {
          var f = items[j].getAsFile && items[j].getAsFile();
          if (f) out.push(f);
        }
      }
    } catch (_) {}
    return out;
  }

  // File → 本地绝对路径：优先 getPathForFile，否则落盘为临时文件。
  function resolveClipboardFilePaths(files) {
    var api = window.shellAPI;
    var tasks = [];
    for (var i = 0; i < files.length; i++) {
      (function (file) {
        var p = '';
        try {
          if (api && typeof api.getPathForFile === 'function') p = api.getPathForFile(file) || '';
        } catch (_) { p = ''; }
        if (p) { tasks.push(Promise.resolve(p)); return; }
        // 回退：读取文件内容 → base64 → 主进程写临时文件
        if (!api || typeof api.saveTempFile !== 'function') {
          tasks.push(Promise.resolve(''));
          return;
        }
        tasks.push(
          file.arrayBuffer().then(function (buf) {
            var bytes = new Uint8Array(buf);
            var bin = '';
            for (var k = 0; k < bytes.length; k++) bin += String.fromCharCode(bytes[k]);
            var b64 = btoa(bin);
            return api.saveTempFile(b64, file.name || 'pasted.png');
          }).then(function (r) {
            return (r && r.success && r.path) ? r.path : '';
          }).catch(function () { return ''; })
        );
      })(files[i]);
    }
    return Promise.all(tasks).then(function (paths) {
      var out = [];
      for (var n = 0; n < paths.length; n++) { if (paths[n]) out.push(paths[n]); }
      return out;
    });
  }

  // 空态示例任务：点击 chip 把文本填入输入框（不自动发送）。
  // cv-empty 是 agent-view 复用的同一个 DOM 节点，只绑一次即可；
  // 用事件委托到容器，避免未来重建 chip 丢绑定。
  (function setupEmptyExamples() {
    var empty = document.getElementById('cv-empty');
    var input = document.getElementById('cv-input');
    if (!empty || !input) return;
    empty.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.cv-example') : null;
      if (!btn || !empty.contains(btn)) return;
      var text = (btn.textContent || '').trim();
      if (!text) return;
      input.value = text;
      try {
        input.focus();
        var end = input.value.length;
        input.setSelectionRange(end, end);
      } catch (_) {}
    });
  })();

  (function setupPasteToAttach() {
    var input = document.getElementById('cv-input');
    if (!input) return;
    input.addEventListener('paste', function (e) {
      var files = collectClipboardFiles(e);
      if (!files.length) return; // 纯文本：不拦截，走原生粘贴
      e.preventDefault(); // 阻止把文件名文本插入 textarea
      shellToast('正在处理粘贴的附件…', 3000);
      resolveClipboardFilePaths(files).then(function (paths) {
        if (!paths.length) { shellToast('粘贴的附件无法读取'); return; }
        return attachFilesToActive(paths).then(function (res) {
          var results = (res && res.results) || [];
          var okN = 0, failN = 0;
          for (var i = 0; i < results.length; i++) {
            if (results[i] && results[i].success) okN++; else failN++;
          }
          if (okN > 0 && failN === 0) shellToast('已添加 ' + okN + ' 个附件');
          else if (okN > 0) shellToast('已添加 ' + okN + ' 个附件，' + failN + ' 个失败');
          else shellToast('附件上传失败');
          // 附件在网页端渲染需时间，稍后刷新附件 chips
          setTimeout(function () { pollActiveWebview(); }, 800);
          setTimeout(function () { pollActiveWebview(); }, 2500);
        });
      }).catch(function () { shellToast('附件上传失败'); });
    });
  })();

  if (window.AgentView) {
    window.AgentView.init({
      execInActive: execInActive,
      sendText: agentSendText,
      onNewChat: function () {
        var wv = getActiveWebview();
        if (wv) { try { wv.loadURL(getTabHomeUrl(activeId ? findTab(activeId) : null)); } catch (_) {} }
      },
      onInitProject: function () { rbClickOverlayBtn('tokfree-btn-init'); },
      onGoLogin: function () { setViewMode('web'); },
      onSession: function (sessionId) {
        var alias = (lastSessionAliases && lastSessionAliases[sessionId]) || '';
        window.AgentView.setTitle(alias || '当前对话');
        // 记录当前会话 ID，让左侧列表高亮跟随
        if (sessionId !== curSessionId) setCurrentSession(sessionId);
      },
      // AI 正在生成文本时同步给壳层，用于控制「停止生成」按钮显隐
      onGenerating: function (on) {
        cvAgentGenerating = !!on;
        updateStopBtn();
      },
    });
    if (window.ProcessCapsule) {
      try {
        window.ProcessCapsule.init({
          onActiveChange: function (active, src, durationMs) {
            // 任务生命周期（plan/todo 未完成）驱动右侧「AI 状态」：
            // 与 DOM 信号（cvWebRunning：AI 生成/工具执行）取并集，
            // 覆盖「从任务开始到需求完成的全过程」。
            cvTaskActive = !!active;
            updateExecStatus(cvWebRunning || cvTaskActive);
            // 任务计时（方案B）：任务结束（true→false）时把本轮实际时长上报主进程
            if (!active && durationMs > 0 && window.shellAPI && typeof window.shellAPI.reportTaskDuration === 'function') {
              try { window.shellAPI.reportTaskDuration(durationMs, getActiveProfileId()); } catch (_) {}
            }
          }
        });
      } catch (_) {}
    }
    if (viewToggleBtn) {
      viewToggleBtn.addEventListener('click', function () {
        setViewMode(getViewMode() === 'agent' ? 'web' : 'agent');
      });
    }
    setViewMode(getViewMode());
    // 加载 profileId → providerId 映射（用于识别 API 型平台标签）
    refreshProfileProviderMap();
    // init 后立即同步一次目录，避免等下一次轮询才评估初始化横幅
    syncRightBar();
    // 兜底轮询刷新对话内容（仅 Agent 视图可见时真正拉取）；
    // 需求2 已改为事件驱动为主，此处降频到 5s 兜底。
    setInterval(function () {
      if (getViewMode() === 'agent' && window.AgentView) window.AgentView.refresh(false);
    }, 5000);
  }

  // syncRightBar 已并入 pollActiveWebview（2s），此处不再单开 3s 定时器，避免重复 executeJavaScript。
  // 需求2：会话列表容忍度较高，从 15s 降到 5s（事件驱动覆盖消息/状态，此处为兜底轮询）
  setInterval(syncSessionList, 5000);

})();
