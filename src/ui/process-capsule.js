/**
 * TokFree 壳层「进程胶囊」（Process Capsule）—— 任务进度可视化
 *
 * 参考 ZCode Agent 的进度可视化：右下角可折叠小胶囊，
 *   折叠态：小胶囊（"工作中 39分10秒" / "已完成 9 项"）
 *   展开态：步骤列表（✓ 已完成 / → 进行中 / ○ 待办）+ 进度 + 实时计时
 *   已完成步骤可点开看详情
 *
 * 数据源：todo_write 列表（经 shellAPI.shellTodoList(profileId) IPC 读取）。
 * 样式本模块自注入（幂等），不改 shell.css。
 * 本模块不直接碰 webview；由 shell.js 在切换标签/视图时调用 setProfile/setVisible/setRunning。
 */
var PC_GLOBAL = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
PC_GLOBAL.ProcessCapsule = (function () {
  'use strict';

  var root = null, progressPillEl = null, timerPillEl = null, panelEl = null, stepsEl = null, collapseBtn = null;
  var progressEl = null, footTimerEl = null, pillCountEl = null, timerLabelEl = null, timerTextEl = null, timerIconEl = null;
  var styleInjected = false;
  var inited = false;
  var visible = false;
  var currentProfileId = '';
  var running = false;
  var todosByProfile = {};
  var planByProfile = {};
  var sourceByProfile = {};
  var stateByProfile = {};
  var pollTimer = null;
  var tickTimer = null;
  var fetchInFlight = false;
  var expanded = false;
  var prevAllDone = false;
  // 任务活跃回调：render() 每次算出 hasActive 后若变化，通知外部（shell.js 用于驱动右侧「AI 状态」）。
  var onActiveChange = null;
  var lastActive = null;

  var LS_EXPANDED = 'tokfree-pc-expanded';

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 毫秒 → "X时X分X秒" / "X分X秒" */
  function fmtDur(ms) {
    if (!ms || ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h > 0) return h + '时' + m + '分' + sec + '秒';
    return m + '分' + sec + '秒';
  }

  // todo 模式超时兜底阈值：running=false 持续超过此时长且仍有 in_progress → 视为该轮已结束。
  var STALE_MS = 5 * 60 * 1000;

  /** 纯函数：todo 模式超时兜底判定——有 in_progress、未运行、且距最后活跃超过 staleMs。 */
  function todoStale(active, isRunning, lastActiveAt, now, staleMs) {
    return active > 0 && !isRunning && !!lastActiveAt && (now - lastActiveAt) > (staleMs || STALE_MS);
  }

  /** 纯分类：统计各状态数量 + 是否全部完成 + 是否「工作中」 */
  function classify(todos, isRunning) {
    var done = 0, active = 0, pending = 0;
    var list = todos || [];
    for (var i = 0; i < list.length; i++) {
      var status = list[i] && list[i].status;
      if (status === 'completed') done++;
      else if (status === 'in_progress') active++;
      else pending++;
    }
    var allDone = list.length > 0 && done === list.length;
    var hasActive = active > 0 || (!!isRunning && !allDone);
    return { done: done, active: active, pending: pending, allDone: allDone, hasActive: hasActive };
  }

  /** 纯函数：把 plan.modules 映射为胶囊步骤。
   *  done/skipped → completed；assigned/ready → in_progress；pending → pending；failed → completed（单独用 ✗ 标记，计入完成避免永远"工作中"）。
   *  步骤文本 = 模块名 +（有 assignee 时 " @assignee"）。 */
  function planModulesToSteps(plan) {
    var mods = (plan && Array.isArray(plan.modules)) ? plan.modules : [];
    var out = [];
    for (var i = 0; i < mods.length; i++) {
      var m = mods[i] || {};
      var s = m.status;
      var mapped;
      var failed = (s === 'failed');
      if (s === 'done' || s === 'skipped' || failed) mapped = 'completed';
      else if (s === 'assigned' || s === 'ready') mapped = 'in_progress';
      else mapped = 'pending';
      var name = m.name || m.id || ('模块' + (i + 1));
      var content = name + (m.assignee ? ' @' + m.assignee : '');
      out.push({ content: (failed ? '✗ ' : '') + content, status: mapped, failed: failed });
    }
    return out;
  }

  /** 纯函数：plan 是否全部完成（done/skipped/failed 均视为"已结束"）。 */
  function planAllDone(plan) {
    var mods = (plan && Array.isArray(plan.modules)) ? plan.modules : [];
    if (mods.length === 0) return false;
    return mods.every(function (m) {
      var s = m && m.status;
      return s === 'done' || s === 'skipped' || s === 'failed';
    });
  }

  /** 推导当前 profile 的展示视图（含计时推进/冻结副作用，供 render/tick/updateFoot 共用）。 */
  function computeView(pid) {
    var todos = todosOf(pid);
    var src = sourceOf(pid);
    var plan = planOf(pid);
    var done = 0, active = 0, pending = 0, i;
    for (i = 0; i < todos.length; i++) {
      var status = todos[i].status;
      if (status === 'completed') done++;
      else if (status === 'in_progress') active++;
      else pending++;
    }
    var total = todos.length;
    var allDone = total > 0 && done === total;
    var hasActive;
    if (src === 'plan') {
      // plan 模式：只要未全部结束就持续"工作中"，不依赖 running（AI 不生成也不断表）。
      hasActive = total > 0 && !allDone;
    } else {
      hasActive = active > 0 || (running && !allDone);
    }
    var s = st(pid);
    // plan 模式计时起点 = plan.createdAt（"从开始列计划"起算）。
    if (src === 'plan' && plan && plan.createdAt && s.startedAt === 0 && s.frozenElapsed == null) {
      s.startedAt = plan.createdAt;
    }
    // 记录活跃时刻：running=true 即视为活跃（供 todo 超时兜底判断"已长时间不活跃"）。
    if (running) s.lastActiveAt = Date.now();
    // todo 模式超时兜底：有 in_progress 但窗口已长时间不活跃（running=false 持续 > STALE_MS）
    // → 视为该轮已结束（冻结计时、不再"工作中"），防 Worker 报 DONE 未收尾 todo 导致永计时。
    var stale = false;
    if (src !== 'plan' && hasActive && todoStale(active, running, s.lastActiveAt, Date.now())) {
      hasActive = false;
      stale = true;
    }
    if (hasActive) {
      if (s.frozenElapsed != null) { s.startedAt = Date.now(); s.frozenElapsed = null; }
      if (!s.startedAt) s.startedAt = Date.now();
    } else if (allDone || stale) {
      if (s.startedAt && s.frozenElapsed == null) s.frozenElapsed = Date.now() - s.startedAt;
    }
    var elapsed = elapsedOf(pid);
    var frozen = s.frozenElapsed;
    var ps = pillState(todos, running, elapsed, frozen, hasActive, stale);
    return { todos: todos, done: done, active: active, pending: pending, total: total, allDone: allDone, hasActive: hasActive, elapsed: elapsed, frozen: frozen, pill: ps };
  }

  function st(pid) {
    var k = pid || '__default__';
    if (!stateByProfile[k]) stateByProfile[k] = { startedAt: 0, frozenElapsed: null, source: '', lastActiveAt: 0 };
    return stateByProfile[k];
  }

  function planOf(pid) { return planByProfile[pid || '__default__'] || null; }

  function sourceOf(pid) { return sourceByProfile[pid || '__default__'] || 'todo'; }

  function elapsedOf(pid) {
    var s = st(pid);
    if (s.frozenElapsed != null) return s.frozenElapsed;
    if (s.startedAt) return Date.now() - s.startedAt;
    return 0;
  }

  function todosOf(pid) {
    return todosByProfile[pid || '__default__'] || [];
  }

  function injectStyle() {
    if (styleInjected || typeof document === 'undefined') return;
    if (document.getElementById('tokfree-process-capsule-style')) { styleInjected = true; return; }
    var style = document.createElement('style');
    style.id = 'tokfree-process-capsule-style';
    style.textContent = [
      '.pc-hidden { display: none !important; }',
      '#pc-root { position: absolute; right: 12px; top: 56px; width: 280px; z-index: 30; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; font-size: 12px; }',
      '.pc-pill { display: inline-flex; align-items: center; gap: 7px; padding: 7px 13px; border-radius: 999px; background: var(--panel, #1b1d2b); border: 1px solid var(--border-strong, #2a2d40); color: var(--text, #e6e8f0); box-shadow: 0 6px 20px rgba(0,0,0,.28); user-select: none; }',
      '.pc-progress-pill { cursor: pointer; }',
      '.pc-progress-pill:hover { border-color: var(--accent, #7c6cff); }',
      '.pc-timer-pill { cursor: default; }',
      '.pc-pill-label { font-weight: 600; }',
      '.pc-pill-timer { color: var(--accent, #7c6cff); font-variant-numeric: tabular-nums; }',
      '.pc-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid rgba(124,108,255,0.25); border-top-color: var(--accent, #7c6cff); animation: pc-spin 0.8s linear infinite; }',
      '@keyframes pc-spin { to { transform: rotate(360deg); } }',
      '.pc-ico-done { color: var(--ok, #4ade80); font-weight: 700; }',
      '.pc-ico-pending { color: var(--text-3, #6b7089); }',
      '.pc-panel { width: 100%; max-height: 340px; display: flex; flex-direction: column; background: var(--panel, #1b1d2b); border: 1px solid var(--border-strong, #2a2d40); border-radius: 12px; box-shadow: 0 10px 32px rgba(0,0,0,.34); overflow: hidden; }',
      '.pc-panel-header { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border, #2a2d40); }',
      '.pc-panel-title { font-weight: 600; color: var(--text, #e6e8f0); flex: 1 1 auto; }',
      '.pc-panel-progress { color: var(--text-3, #6b7089); font-variant-numeric: tabular-nums; }',
      '.pc-collapse { border: none; background: transparent; color: var(--text-3, #6b7089); cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 4px; }',
      '.pc-collapse:hover { color: var(--accent, #7c6cff); }',
      '.pc-steps { flex: 1 1 auto; overflow-y: auto; padding: 6px 4px; }',
      '.pc-steps::-webkit-scrollbar { width: 6px; }',
      '.pc-steps::-webkit-scrollbar-thumb { background: var(--border-strong, #2a2d40); border-radius: 3px; }',
      '.pc-step { display: flex; gap: 8px; padding: 6px 10px; border-radius: 8px; align-items: flex-start; }',
      '.pc-step-ico { flex: 0 0 auto; width: 16px; text-align: center; line-height: 18px; font-weight: 700; }',
      '.pc-step-main { flex: 1 1 auto; min-width: 0; }',
      '.pc-step-text { color: var(--text-2, #9298b8); line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.pc-done .pc-step-ico { color: var(--ok, #4ade80); }',
      '.pc-done { cursor: pointer; }',
      '.pc-done:hover { background: rgba(124,108,255,0.08); }',
      '.pc-active .pc-step-ico { color: var(--accent, #7c6cff); }',
      '.pc-active .pc-step-text { color: var(--text, #e6e8f0); font-weight: 600; }',
      '.pc-pending .pc-step-ico { color: var(--text-3, #6b7089); }',
      '.pc-pending .pc-step-text { color: var(--text-3, #6b7089); }',
      '.pc-step-detail { display: none; margin-top: 4px; color: var(--text-2, #9298b8); white-space: pre-wrap; word-break: break-word; font-size: 11px; line-height: 1.5; }',
      '.pc-open .pc-step-text { white-space: normal; }',
      '.pc-open .pc-step-detail { display: block; }',
      '.pc-panel-footer { flex: 0 0 auto; padding: 8px 12px; border-top: 1px solid var(--border, #2a2d40); color: var(--text-3, #6b7089); font-variant-numeric: tabular-nums; }',
    ].join(String.fromCharCode(10));
    (document.head || document.documentElement).appendChild(style);
    styleInjected = true;
  }

  function buildDom() {
    var host = document.getElementById('chat-view');
    if (!host) return false;
    var existing = document.getElementById('pc-root');
    if (existing) {
      root = existing;
    } else {
      root = document.createElement('div');
      root.id = 'pc-root';
      root.className = 'pc-hidden';
      // 顺序：计时胶囊(上) → 任务进度胶囊(下) → 面板(最后)。
      // panel 放最后，展开时向下生长，不会把上面两个胶囊推走。
      root.innerHTML =
        '<div id="pc-timer-pill" class="pc-pill pc-timer-pill">' +
          '<span id="pc-timer-icon"></span>' +
          '<span id="pc-timer-label" class="pc-pill-label"></span>' +
          '<span id="pc-timer-text" class="pc-pill-timer"></span>' +
        '</div>' +
        '<div id="pc-progress-pill" class="pc-pill pc-progress-pill" title="点击展开任务进度">' +
          '<span class="pc-pill-label">任务进度</span>' +
          '<span id="pc-pill-count" class="pc-pill-timer"></span>' +
        '</div>' +
        '<div id="pc-panel" class="pc-panel pc-hidden">' +
          '<div class="pc-panel-header">' +
            '<span class="pc-panel-title">任务进度</span>' +
            '<span id="pc-progress" class="pc-panel-progress"></span>' +
            '<button id="pc-collapse" class="pc-collapse" title="收起">▾</button>' +
          '</div>' +
          '<div id="pc-steps" class="pc-steps"></div>' +
          '<div class="pc-panel-footer"><span id="pc-foot-timer"></span></div>' +
        '</div>';
      host.appendChild(root);
    }
    progressPillEl = $('pc-progress-pill');
    timerPillEl = $('pc-timer-pill');
    panelEl = $('pc-panel');
    stepsEl = $('pc-steps');
    collapseBtn = $('pc-collapse');
    progressEl = $('pc-progress');
    footTimerEl = $('pc-foot-timer');
    pillCountEl = $('pc-pill-count');
    timerIconEl = $('pc-timer-icon');
    timerLabelEl = $('pc-timer-label');
    timerTextEl = $('pc-timer-text');
    return true;
  }

  function bindEvents() {
    if (progressPillEl) progressPillEl.addEventListener('click', function () { setExpanded(!expanded); });
    // timer 胶囊不可点击：不绑定任何事件（需求1-B）。
    if (collapseBtn) collapseBtn.addEventListener('click', function () { setExpanded(false); });
    if (stepsEl) stepsEl.addEventListener('click', function (ev) {
      var node = ev.target;
      while (node && node !== stepsEl && !(node.classList && node.classList.contains('pc-done'))) node = node.parentNode;
      if (node && node !== stepsEl && node.classList && node.classList.contains('pc-done')) {
        node.classList.toggle('pc-open');
      }
    });
  }

  function setExpanded(on) {
    expanded = !!on;
    if (panelEl) panelEl.classList.toggle('pc-hidden', !expanded);
    try { localStorage.setItem(LS_EXPANDED, expanded ? '1' : '0'); } catch (_) {}
  }

  /** 纯函数：根据 todos/running/计时推导胶囊三态（空闲/工作中/已完成/待办）。
   *  空列表且未运行 → { kind:'idle', label:'空闲' }；空列表但 running=true → working。 */
  function pillState(todos, isRunning, elapsedMs, frozenElapsed, forceActive, stale) {
    var list = todos || [];
    var total = list.length;
    var c = classify(list, isRunning);
    // 超时兜底：todo 模式判定该轮已结束 → 按"已完成"呈现（冻结计时），不再"工作中"。
    if (stale === true && total > 0) {
      return { kind: 'done', label: '已完成 ' + total + ' 项', timer: frozenElapsed != null ? '用时 ' + fmtDur(frozenElapsed) : '' };
    }
    // forceActive：plan（多 Agent）模式下，只要未全部完成就持续"工作中"计时，不依赖 running。
    if (forceActive === true && total > 0 && !c.allDone) c.hasActive = true;
    if (c.hasActive) return { kind: 'working', label: '工作中', timer: fmtDur(elapsedMs) };
    if (c.allDone) return { kind: 'done', label: '已完成 ' + total + ' 项', timer: frozenElapsed != null ? '用时 ' + fmtDur(frozenElapsed) : '' };
    if (total === 0) return { kind: 'idle', label: '空闲', timer: '' };
    return { kind: 'pending', label: '待办 ' + c.pending + ' 项', timer: '' };
  }

  /** 空列表时的步骤区占位。 */
  function buildEmptySteps() {
    return '<div class="pc-step pc-pending"><span class="pc-step-ico">○</span>' +
      '<div class="pc-step-main"><div class="pc-step-text">暂无任务步骤</div></div></div>';
  }

  function buildSteps(todos) {
    var html = '';
    for (var i = 0; i < todos.length; i++) {
      var t = todos[i] || {};
      var status = t.status;
      var cls, ico;
      if (status === 'completed') { cls = 'pc-step pc-done'; ico = '✓'; }
      else if (status === 'in_progress') { cls = 'pc-step pc-active'; ico = '→'; }
      else { cls = 'pc-step pc-pending'; ico = '○'; }
      var detail = status === 'completed' ? '<div class="pc-step-detail">' + esc(t.content) + '</div>' : '';
      html += '<div class="' + cls + '" data-idx="' + i + '">' +
        '<span class="pc-step-ico">' + ico + '</span>' +
        '<div class="pc-step-main">' +
          '<div class="pc-step-text">' + esc(t.content) + '</div>' +
          detail +
        '</div>' +
      '</div>';
    }
    return html;
  }

  /** 兼容旧调用：新布局把胶囊固定在对话区右上角（CSS top/right 控制），清掉遗留的 bottom 内联值。 */
  function positionRoot() {
    if (!root) return;
    try { root.style.bottom = ''; } catch (_) {}
  }

  function updateFoot() {
    if (!footTimerEl) return;
    var v = computeView(currentProfileId);
    if (v.hasActive) footTimerEl.textContent = '工作中 · ' + fmtDur(v.elapsed);
    else if (v.allDone && v.frozen != null) footTimerEl.textContent = '已完成 · 用时 ' + fmtDur(v.frozen);
    else footTimerEl.textContent = '';
  }

  /** 活跃态变化时通知外部（即使胶囊不可见也通知：右侧 AI 状态与视图无关）。
   *  durationMs：仅在 true→false 边沿（任务结束）传本轮任务实际时长，供壳层上报（方案B 任务计时）。 */
  function notifyActiveChange(active, src, durationMs) {
    if (active === lastActive) return;
    var wasActive = lastActive;
    lastActive = active;
    var dur = (!active && wasActive) ? (durationMs || 0) : 0;
    try { if (onActiveChange) onActiveChange(active, src || '', dur); } catch (_) {}
  }

  function render() {
    if (!root) return;
    var v = computeView(currentProfileId);
    var durMs = (!v.hasActive && v.frozen != null) ? v.frozen : v.elapsed;
    notifyActiveChange(!!v.hasActive, sourceOf(currentProfileId), durMs);
    if (!visible) { root.classList.add('pc-hidden'); return; }
    root.classList.remove('pc-hidden');
    var todos = v.todos, total = v.total, allDone = v.allDone;
    var ps = v.pill;

    // 「任务进度」胶囊：任务进度 + done/total
    if (pillCountEl) pillCountEl.textContent = total ? (v.done + '/' + total) : '';
    // 「计时」胶囊：工作中/已完成/空闲 + 计时
    var icon, label, timer;
    if (ps.kind === 'working') icon = '<span class="pc-spin"></span>';
    else if (ps.kind === 'done') icon = '<span class="pc-ico-done">✓</span>';
    else icon = '<span class="pc-ico-pending">○</span>';
    label = ps.label;
    timer = ps.timer;
    if (timerIconEl) timerIconEl.innerHTML = icon;
    if (timerLabelEl) timerLabelEl.textContent = label;
    if (timerTextEl) timerTextEl.textContent = timer;
    if (progressEl) progressEl.textContent = total ? (v.done + '/' + total) : '';
    if (stepsEl) stepsEl.innerHTML = total ? buildSteps(todos) : buildEmptySteps();
    if (allDone && !prevAllDone) setExpanded(false);
    prevAllDone = allDone;
    positionRoot();
    updateFoot();
  }

  /** 每秒仅刷新计时文本，避免整块重绘 */
  function tick() {
    try {
      if (!visible || !root || root.classList.contains('pc-hidden')) return;
      var v = computeView(currentProfileId);
      if (v.hasActive) {
        if (timerTextEl) timerTextEl.textContent = fmtDur(v.elapsed);
        updateFoot();
      }
    } catch (_) {}
  }

  /** 有 plan（多 Agent 模式）优先用 plan；否则回退 todo（单聊）。 */
  function refresh() {
    if (fetchInFlight) return;
    var pid = currentProfileId || '';
    var key = pid || '__default__';
    var api = window.shellAPI;
    var canPlan = api && typeof api.shellPlanGet === 'function';
    var canTodo = api && typeof api.shellTodoList === 'function';
    if (!canPlan && !canTodo) return;
    fetchInFlight = true;
    var planP = canPlan ? api.shellPlanGet(pid).catch(function () { return null; }) : Promise.resolve(null);
    planP.then(function (pres) {
      if (pid !== currentProfileId) return;
      var plan = (pres && pres.success) ? pres.plan : null;
      if (plan && Array.isArray(plan.modules) && plan.modules.length > 0) {
        planByProfile[key] = plan;
        sourceByProfile[key] = 'plan';
        todosByProfile[key] = planModulesToSteps(plan);
        render();
        return null;
      }
      // 无 plan → 回退 todo
      planByProfile[key] = null;
      if (!canTodo) { sourceByProfile[key] = 'todo'; todosByProfile[key] = []; render(); return null; }
      return api.shellTodoList(pid).then(function (res) {
        if (pid !== currentProfileId) return;
        sourceByProfile[key] = 'todo';
        if (res && res.success && Array.isArray(res.todos)) todosByProfile[key] = res.todos;
        render();
      }).catch(function () {});
    }).catch(function () {}).then(function () { fetchInFlight = false; });
  }

  function setProfile(pid) {
    pid = pid || '';
    if (pid === currentProfileId) { refresh(); return; }
    currentProfileId = pid;
    render();
    refresh();
  }

  function setVisible(on) {
    visible = !!on;
    if (!root) return;
    if (!visible) { root.classList.add('pc-hidden'); return; }
    render();
    refresh();
  }

  function setRunning(on) {
    running = !!on;
    if (!running) return;
    // plan 模式下计时由 plan.createdAt 驱动、不依赖 running；仅需刷新渲染。
    if (sourceOf(currentProfileId) === 'plan') { render(); return; }
    var todos = todosOf(currentProfileId);
    if (classify(todos, true).allDone) return;
    var s = st(currentProfileId);
    if (s.startedAt === 0 && s.frozenElapsed == null) s.startedAt = Date.now();
    render();
  }

  function init(opts) {
    if (opts && typeof opts.onActiveChange === 'function') onActiveChange = opts.onActiveChange;
    if (inited) return;
    try {
      injectStyle();
      if (!buildDom()) return;
      bindEvents();
      try { expanded = localStorage.getItem(LS_EXPANDED) === '1'; } catch (_) { expanded = false; }
      setExpanded(expanded);
      inited = true;
      // 初始化时序修复：setProfile/setVisible 可能在 init 之前就被调用（标签恢复/切换），
      // 那时 root 为 null、渲染被丢弃。建完 DOM 后立即补渲染一次并按需拉取。
      try { render(); } catch (_) {}
      try { if (visible) refresh(); } catch (_) {}
      if (!pollTimer) pollTimer = setInterval(function () { refresh(); }, 3000);
      if (!tickTimer) tickTimer = setInterval(tick, 1000);
      try { window.addEventListener('resize', positionRoot); } catch (_) {}
    } catch (_) {}
  }

  return {
    init: init,
    setProfile: setProfile,
    setVisible: setVisible,
    setRunning: setRunning,
    refresh: refresh,
    setExpanded: setExpanded,
    // 仅供单元测试的纯函数（不依赖 DOM）
    _test: { fmtDur: fmtDur, classify: classify, pillState: pillState, todoStale: todoStale, planModulesToSteps: planModulesToSteps, planAllDone: planAllDone },
  };
})();
