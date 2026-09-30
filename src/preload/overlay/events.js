/**
 * 覆盖层按钮事件绑定
 * 由原 preload.js 拆分而来，逻辑保持不变。
 */
const state = require('../dom/state');
const { getProviderByUrl } = require('../../providers');
const { hideOverlay, showOverlay, renderHistory, commandHistory, showToast, showConfirmDialog, showAccountSelectDialog, hideFirstTimeDialog } = require('./ui');
const { handleInitProject, renderSessions } = require('../dom/session-list');
const { handleManualParse } = require('../dom/observer');
const { sendToChat } = require('../dom/chat-input');
const { runCompaction, checkPendingInit } = require('../dom/compaction');
const missionControl = require('./mission-control');
const goalPanel = require('./goal-panel');

/**
 * 渲染窗口列表（浮动管理面板内）
 */
async function renderWindowList() {
  const list = document.getElementById('tokfree-window-list');
  if (!list) return;
  try {
    const res = await window.electronAPI.listProfiles();
    const profiles = res && res.success ? res.profiles : [];
    if (!profiles || profiles.length === 0) {
      list.innerHTML = '<div class="tokfree-session-empty">暂无窗口</div>';
      return;
    }
    // 获取平台名映射
    const providerMap = {};
    try {
      const pvRes = await window.electronAPI.listProviders();
      if (pvRes && pvRes.success) {
        (pvRes.providers || []).forEach(pv => { providerMap[pv.id] = pv.name; });
      }
    } catch (_) {}

    // 窗口运行状态（AI 在干嘛：空闲/思考中/长任务/中断/限流冷却）
    const statusMap = {};
    try {
      if (window.electronAPI.listWindowsStatus) {
        const stRes = await window.electronAPI.listWindowsStatus();
        if (stRes && stRes.success) {
          (stRes.windows || []).forEach(w => { statusMap[w.profileId] = w; });
        }
      }
    } catch (_) {}
    const toneColor = { idle: '#7fd6a3', busy: '#ffc107', warn: '#ff6b7a', banned: '#ff4d4f' };
    const acctColor = { active: '#7fd6a3', limited: '#ffc107', expired: '#ff6b7a', disabled: '#5d6280' };
    const acctText = { active: '正常', limited: '限流', expired: '过期', disabled: '停用' };
    list.innerHTML = profiles.map(p => {
      const pname = providerMap[p.providerId] || '平台';
      const st = statusMap[p.id];
      const label = st ? st.label : '未打开';
      const tone = st ? st.state : 'idle';
      const color = toneColor[tone] || '#8a90b8';
      const isBanned = tone === 'banned';
      // 禁言用 data 属性记录剩余秒数，供每秒倒计时刷新
      const banAttr = isBanned && st && st.banRemainSec ? ' data-ban-remain="' + st.banRemainSec + '"' : '';
      const dot = '<span class="tokfree-win-state" style="color:' + color + ';font-size:11px;flex-shrink:0;' +
        (isBanned ? 'font-weight:700;background:rgba(255,77,79,0.15);padding:1px 6px;border-radius:6px;border:1px solid rgba(255,77,79,0.4);' : '') +
        '"' + banAttr + '>● ' + label + '</span>';
      // 账号标签
      let acctHtml = '';
      const acct = p.account;
      if (acct && (acct.label || acct.group || (acct.status && acct.status !== 'active'))) {
        const aColor = acctColor[acct.status] || '#8a90b8';
        const aText = acctText[acct.status] || '正常';
        const parts = [];
        if (acct.label) parts.push(acct.label);
        if (acct.group) parts.push('[' + acct.group + ']');
        parts.push(aText);
        acctHtml = '<span class="tokfree-window-sep">|</span>' +
          '<span class="tokfree-window-acct" style="color:' + aColor + ';font-size:11px;flex-shrink:0;">' + parts.join(' ') + '</span>';
      }
      return '<div class="tokfree-window-item" data-profile-id="' + p.id + '">' +
        '<span class="tokfree-window-left">' +
          '<span class="tokfree-window-name">' + p.name + '</span>' +
          (function () {
            var _role = (statusMap[p.id] && statusMap[p.id].role) || '';
            if (_role === 'master') return '<span class="tokfree-role-badge tokfree-role-master" title="主大脑">主</span>';
            if (_role === 'worker') { var _bt = statusMap[p.id].belongTo || ''; var _bname = ''; if (_bt) { var _bm = profiles.find(function(x){return x.id===_bt;}); _bname = _bm ? _bm.name : _bt; } return '<span class="tokfree-role-badge tokfree-role-worker" title="子Agent' + (_bname ? '（属 '+_bname+'）' : '') + '">次' + (_bname ? '·' + _bname.slice(0,4) : '') + '</span>'; }
            return '';
          })() +
          '<span class="tokfree-window-sep">|</span>' +
          '<span class="tokfree-window-status">' + pname + '</span>' +
          acctHtml +
          '<span class="tokfree-window-sep">|</span>' +
          dot +
        '</span>' +
        '<span class="tokfree-window-cfg" data-profile-id="' + p.id + '" title="窗口设置"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;pointer-events:none;margin:0 auto;"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>' +
        '<span class="tokfree-window-role" data-profile-id="' + p.id + '" title="改角色">角色</span>' +
        '<span class="tokfree-window-del" data-profile-id="' + p.id + '" title="删除窗口">删除</span>' +
      '</div>';
    }).join('');
    list.querySelectorAll('.tokfree-window-item').forEach(el => {
      el.addEventListener('click', async (e) => {
        // 点击删除/设置/角色按钮不触发切换
        if (e.target.classList.contains('tokfree-window-del')) return;
        if (e.target.classList.contains('tokfree-window-cfg')) return;
        if (e.target.classList.contains('tokfree-window-role')) return;
        const profileId = el.dataset.profileId;
        try {
          const r = await window.electronAPI.openProfileWindow(profileId);
          if (r && r.success) {
            if (r.focused) {
              showToast('已切换到该窗口', 2000);
              closeWindowManager();
            } else {
              showToast('已打开窗口', 2000);
            }
          } else {
            showToast((r && r.error) || '打开失败', 3000);
          }
        } catch (err) {
          showToast('打开窗口失败: ' + (err.message || err), 3000);
        }
      });
    });
    // 绑定设置按钮
    list.querySelectorAll('.tokfree-window-cfg').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        openProfileConfig(btn.dataset.profileId);
      });
    });
    // 绑定改角色按钮
    list.querySelectorAll('.tokfree-window-role').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await openRoleMenu(btn, btn.dataset.profileId); }
        catch (err) { showToast('打开角色菜单失败: ' + (err.message || err), 3000); }
      });
    });
    // 绑定删除按钮
    list.querySelectorAll('.tokfree-window-del').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const profileId = btn.dataset.profileId;
        try {
          const r = await window.electronAPI.deleteProfileWindow(profileId);
          if (r && r.success) {
            showToast('已删除窗口', 2000);
            await renderWindowList();
          } else {
            showToast((r && r.error) || '删除失败', 3000);
          }
        } catch (err) {
          showToast('删除失败: ' + (err.message || err), 3000);
        }
      });
    });
  } catch (err) {
    list.innerHTML = '<div class="tokfree-session-empty">加载失败</div>';
  }
  renderStatsPanel();
}

/**
 * 打开「改角色」菜单：设为主大脑 / 设为子Agent（可选归属）/ 清除角色
 * 替代 window.prompt（Electron 不支持，会直接返回 null）
 */
async function openRoleMenu(anchorEl, profileId) {
 try {
  const old = document.getElementById('tokfree-role-menu');
  if (old) { if (typeof old.__close === 'function') old.__close(); else old.remove(); }

  // 关键：快照锚点位置。窗口管理面板每 3s 会调用 renderWindowList() 重建 list.innerHTML，
  // 销毁旧的“角色”按钮；await 之后 anchorEl 很可能已脱离 DOM，其 getBoundingClientRect()
  // 会返回全 0，导致菜单被定位到视口左上角（用户看不到 → 误以为“点击没反应”）。
  let anchorRect = null;
  try { anchorRect = anchorEl.getBoundingClientRect(); } catch (_) {}

  let profiles = [];
  try {
    const pr = await window.electronAPI.listProfiles();
    profiles = (pr && pr.success && pr.profiles) || [];
  } catch (_) {}

  const menu = document.createElement('div');
  menu.id = 'tokfree-role-menu';
  // 全部使用 inline style + !important，避免被网站 CSS 覆盖
  const _menuStyle = {
    position: 'fixed', 'z-index': '2147483648',
    background: '#1e2030', border: '1px solid #444', color: '#fff',
    padding: '6px', 'border-radius': '8px',
    'box-shadow': '0 4px 16px rgba(0,0,0,.5)',
    'min-width': '150px', display: 'flex', 'flex-direction': 'column',
    gap: '2px', left: '-9999px', top: '-9999px',
    'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    'font-size': '12px', 'line-height': '1.5',
    'pointer-events': 'auto',
  };
  for (const _k in _menuStyle) menu.style.setProperty(_k, _menuStyle[_k], 'important');
  // 辅助：创建带 inline style 的菜单项
  function _makeItem(text) {
    const _el = document.createElement('div');
    _el.textContent = text;
    const _s = {
      padding: '6px 10px', color: '#fff', 'border-radius': '6px',
      cursor: 'pointer', 'white-space': 'nowrap', 'user-select': 'none',
      background: 'transparent',
    };
    for (const _k in _s) _el.style.setProperty(_k, _s[_k], 'important');
    _el.addEventListener('mouseenter', () => _el.style.setProperty('background', 'rgba(139,147,255,0.25)', 'important'));
    _el.addEventListener('mouseleave', () => _el.style.setProperty('background', 'transparent', 'important'));
    return _el;
  }

  function close() {
    try { menu.remove(); } catch (_) {}
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
  }
  function onDocDown(ev) {
    if (!menu.contains(ev.target)) close();
  }
  function onKey(ev) {
    if (ev.key === 'Escape') close();
  }
  menu.__close = close;

  async function applyRole(role, belongTo) {
    try {
      const r = await window.electronAPI.setProfileRole(profileId, role, belongTo || '');
      if (r && r.success) {
        showToast(role === 'master' ? '已设为主大脑' : (role === 'worker' ? '已设为子Agent' : '已清除角色'), 2000);
        close();
        await renderWindowList();
      } else {
        showToast((r && r.error) || '设置失败', 3000);
      }
    } catch (err) {
      showToast('设置失败: ' + (err.message || err), 3000);
    }
  }

  // 设为主大脑
  const itMaster = _makeItem('设为主大脑');
  itMaster.addEventListener('click', () => applyRole('master', ''));
  menu.appendChild(itMaster);

  // 设为子Agent（点击后展开归属下拉）
  const itWorker = _makeItem('设为子Agent');
  menu.appendChild(itWorker);

  const row = document.createElement('div');
  row.style.setProperty('display', 'none', 'important');
  row.style.setProperty('gap', '6px', 'important');
  row.style.setProperty('padding', '4px 6px', 'important');
  row.style.setProperty('align-items', 'center', 'important');

  const sel = document.createElement('select');
  const _selStyle = {
    flex: '1', 'min-width': '0', background: '#2a2c40',
    border: '1px solid #444', 'border-radius': '6px',
    padding: '4px 6px', color: '#fff', 'font-size': '12px',
  };
  for (const _k in _selStyle) sel.style.setProperty(_k, _selStyle[_k], 'important');

  const optNone = document.createElement('option');
  optNone.value = '';
  optNone.textContent = '不指定归属';
  optNone.style.setProperty('background', '#2a2c40', 'important');
  optNone.style.setProperty('color', '#fff', 'important');
  sel.appendChild(optNone);
  for (const p of profiles) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    o.style.setProperty('background', '#2a2c40', 'important');
    o.style.setProperty('color', '#fff', 'important');
    sel.appendChild(o);
  }

  const okBtn = _makeItem('确定');
  okBtn.style.setProperty('padding', '4px 8px', 'important');
  okBtn.style.setProperty('background', 'rgba(139,147,255,0.35)', 'important');
  okBtn.addEventListener('click', () => applyRole('worker', sel.value));
  row.appendChild(sel);
  row.appendChild(okBtn);
  menu.appendChild(row);

  itWorker.addEventListener('click', () => {
    const isNone = row.style.display === 'none';
    row.style.setProperty('display', isNone ? 'flex' : 'none', 'important');
    position();
  });

  // 清除角色
  const itClear = _makeItem('清除角色');
  itClear.addEventListener('click', () => applyRole('', ''));
  menu.appendChild(itClear);

  // append 到 <html>，避免目标网站对 body 的直接子元素做样式干扰
  try { (document.documentElement || document.body).appendChild(menu); }
  catch (_) { document.body.appendChild(menu); }

  function position() {
    try {
      let rect = null;
      try {
        rect = (anchorEl && anchorEl.isConnected) ? anchorEl.getBoundingClientRect() : null;
      } catch (_) { rect = null; }
      // 锚点已从 DOM 移除（列表定时重建）或无效 → 回退到快照 / 默认坐标
      if (!rect || (!rect.width && !rect.height && !rect.left && !rect.top)) {
        rect = anchorRect || { right: 220, bottom: 220, top: 120 };
      }
      const mw = menu.offsetWidth || 160;
      const mh = menu.offsetHeight || 96;
      let left = rect.right - mw;
      let top = rect.bottom + 4;
      if (!isFinite(left)) left = 100;
      if (!isFinite(top)) top = 100;
      const vw = window.innerWidth || 800;
      const vh = window.innerHeight || 600;
      if (left < 4) left = 4;
      if (top < 4) top = 4;
      if (left + mw > vw - 4) left = Math.max(4, vw - mw - 4);
      if (top + mh > vh - 4) top = Math.max(4, rect.top - mh - 4);
      if (left < 0) left = 0;
      if (top < 0) top = 0;
      menu.style.setProperty('left', left + 'px', 'important');
      menu.style.setProperty('top', top + 'px', 'important');
    } catch (_) {
      menu.style.setProperty('left', '100px', 'important');
      menu.style.setProperty('top', '100px', 'important');
    }
  }
  position();
  setTimeout(position, 0);

  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
 } catch (err) {
   try { console.error('[RoleMenu] 失败:', err); } catch (_) {}
   try { showToast('打开角色菜单失败: ' + (err && err.message ? err.message : err), 3000); } catch (_) {}
 }
}

/**
 * 禁言倒计时每秒 tick（纯前端，只更新文本，不重渲染列表）
 * 元素上用 data-ban-remain 记录剩余秒数，每秒减 1 并更新显示的 label。
 */
function startBanCountdownTick() {
  if (startBanCountdownTick._started) return;
  startBanCountdownTick._started = true;
  setInterval(() => {
    try {
      const els = document.querySelectorAll('.tokfree-win-state[data-ban-remain]');
      for (const el of els) {
        let remain = parseInt(el.getAttribute('data-ban-remain'), 10);
        if (!Number.isFinite(remain) || remain <= 0) { el.removeAttribute('data-ban-remain'); continue; }
        remain -= 1;
        el.setAttribute('data-ban-remain', String(remain));
        const txt = formatRemainText(remain);
        el.textContent = '● 账号受限（剩余 ' + txt + '）';
      }
    } catch (_) {}
  }, 1000);
}

/** 剩余秒数 → 文案（与主进程 formatRemain 一致） */
function formatRemainText(sec) {
  if (!sec || sec <= 0) return '0秒';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return d + '天' + h + '小时' + m + '分';
  if (h > 0) return h + '小时' + m + '分';
  if (m > 0) return m + '分' + s + '秒';
  return s + '秒';
}

/**
 * 打开窗口管理浮动面板
 */
function openWindowManager() {
  const panel = document.getElementById('tokfree-window-manager');
  if (panel) {
    panel.classList.remove('tokfree-hidden');
    renderWindowList();
    renderWatchdogPanel();
    renderStatsPanel();
    renderUsagePanel();
    missionControl.renderMissionControl();
    startBanCountdownTick();
    // 初始化拖动（幂等：用标记避免重复绑定）
    if (!openWindowManager._dragInit) {
      openWindowManager._dragInit = true;
      const hd = panel.querySelector('.tokfree-wm-header');
      makeDraggable(panel, hd);
    }
    // 定时刷新窗口状态，实时反映各 AI 在干嘛
    if (!openWindowManager._timer) {
      openWindowManager._timer = setInterval(() => {
        const p = document.getElementById('tokfree-window-manager');
        if (p && !p.classList.contains('tokfree-hidden')) {
          renderWindowList();
          renderWatchdogPanel();
          renderStatsPanel();
          renderUsagePanel();
          missionControl.renderMissionControl();
        }
      }, 3000);
    }
  }
}

/**
 * 渲染看门狗状态区（窗口管理面板内）
 */
async function renderWatchdogPanel() {
  const stateEl = document.getElementById('tokfree-wd-state');
  const toggleBtn = document.getElementById('tokfree-wd-toggle');
  if (!stateEl || !toggleBtn) return;
  try {
    if (!window.electronAPI || !window.electronAPI.watchdogStatus) {
      stateEl.textContent = '不可用';
      return;
    }
    const res = await window.electronAPI.watchdogStatus();
    const st = res && res.success ? res.status : null;
    if (!st || !st.config) { stateEl.textContent = '不可用'; return; }
    const cfg = st.config;
    let label = '运行中';
    let cls = 'tokfree-wd-ok';
    if (!cfg.enabled) { label = '已禁用'; cls = 'tokfree-wd-off'; }
    else if (cfg.paused) { label = '已暂停'; cls = 'tokfree-wd-paused'; }
    const p = st.profile || {};
    const extra = p.busy ? ' · busy' : (p.cooldownRemain > 0 ? ' · 冷却' + p.cooldownRemain + 's' : '');
    stateEl.textContent = label + extra;
    stateEl.className = 'tokfree-wd-state ' + cls;
    toggleBtn.textContent = cfg.paused ? '恢复' : '暂停';
  } catch (e) {
    stateEl.textContent = '读取失败';
  }
}

/**
 * 渲染「运行统计」区（窗口管理面板内）
 * 数据来自 getEventStats()（{success, daily, summary}）
 */
async function renderStatsPanel() {
  const summaryEl = document.getElementById('tokfree-stats-summary');
  const listEl = document.getElementById('tokfree-stats-list');
  if (!summaryEl || !listEl) return;
  try {
    if (!window.electronAPI || !window.electronAPI.getEventStats) {
      summaryEl.textContent = '不可用';
      listEl.innerHTML = '<div class="tokfree-session-empty">暂无数据</div>';
      return;
    }
    const res = await window.electronAPI.getEventStats();
    const daily = (res && res.success && res.daily) || {};
    const summary = (res && res.success && res.summary) || {};
    summaryEl.textContent = '今日 催促' + (summary.nag || 0) +
      ' · 拦截' + (summary.intercept || 0) +
      ' · 派发' + (summary.dispatch || 0) +
      ' · 完成' + (summary.done || 0);

    // 平台名映射，用于显示窗口名
    const providerMap = {};
    try {
      const pvRes = await window.electronAPI.listProviders();
      if (pvRes && pvRes.success) {
        (pvRes.providers || []).forEach(pv => { providerMap[pv.id] = pv.name; });
      }
    } catch (_) {}
    const profilesRes = await window.electronAPI.listProfiles();
    const profiles = profilesRes && profilesRes.success ? profilesRes.profiles : [];
    const nameMap = {};
    profiles.forEach(p => { nameMap[p.id] = p.name; });

    // 今日日期
    const today = formatDateKey(new Date());
    const rows = [];
    profiles.forEach(p => {
      const stat = (daily[p.id] && daily[p.id][today]) || {};
      if (!stat || Object.keys(stat).length === 0) return;
      const win = p.name || providerMap[p.providerId] || p.id;
      rows.push({ win, nag: stat.nag || 0, intercept: stat.intercept || 0, sent: stat.sent || 0, received: stat.received || 0 });
    });
    if (rows.length === 0) {
      listEl.innerHTML = '<div class="tokfree-session-empty">暂无数据</div>';
      return;
    }
    listEl.innerHTML = rows.map(r =>
      '<div class="tokfree-stats-row">' +
        '<span class="tokfree-stats-win" title="' + r.win + '">' + r.win + '</span>' +
        '<span class="tokfree-stats-nums">催促' + r.nag + ' · 拦截' + r.intercept + ' · 收' + r.received + '/发' + r.sent + '</span>' +
      '</div>'
    ).join('');
  } catch (err) {
    summaryEl.textContent = '读取失败';
    listEl.innerHTML = '<div class="tokfree-session-empty">加载失败</div>';
  }
}

/**
 * 渲染「用量统计」区（窗口管理面板内）
 * 数据来自 getStatsSummary()（{success, data:{today, week, byWindow, daily}}）
 */
async function renderUsagePanel() {
  const summaryEl = document.getElementById('tokfree-usage-summary');
  const listEl = document.getElementById('tokfree-usage-list');
  if (!summaryEl || !listEl) return;
  try {
    if (!window.electronAPI || !window.electronAPI.getStatsSummary) {
      summaryEl.textContent = '不可用';
      listEl.innerHTML = '<div class="tokfree-session-empty">暂无数据</div>';
      return;
    }
    const res = await window.electronAPI.getStatsSummary(7);
    const data = (res && res.success && res.data) || null;
    if (!data) {
      summaryEl.textContent = '暂无数据';
      listEl.innerHTML = '<div class="tokfree-session-empty">暂无数据</div>';
      return;
    }
    const today = data.today || { sent: 0, received: 0, tokens: 0 };
    const week = data.week || { sent: 0, received: 0, tokens: 0 };
    summaryEl.innerHTML =
      '<span class="tokfree-usage-range">今日</span> 发 ' + (today.sent || 0) +
      ' · 收 ' + (today.received || 0) +
      ' · token ' + formatTokens(today.tokens) +
      '<br><span class="tokfree-usage-range">本周</span> 发 ' + (week.sent || 0) +
      ' · 收 ' + (week.received || 0) +
      ' · token ' + formatTokens(week.tokens);

    // 窗口名映射
    const providerMap = {};
    try {
      const pvRes = await window.electronAPI.listProviders();
      if (pvRes && pvRes.success) {
        (pvRes.providers || []).forEach(pv => { providerMap[pv.id] = pv.name; });
      }
    } catch (_) {}
    const profilesRes = await window.electronAPI.listProfiles();
    const profiles = profilesRes && profilesRes.success ? profilesRes.profiles : [];
    const nameMap = {};
    profiles.forEach(p => { nameMap[p.id] = p.name; });

    const byWindow = (data.byWindow || []).slice();
    // 优先显示本周有活动的窗口
    const active = byWindow.filter(w => {
      const wk = w.week || {};
      return (wk.sent || 0) + (wk.received || 0) + (wk.tokens || 0) > 0;
    });
    const list = active.slice(0, 8);
    if (list.length === 0) {
      listEl.innerHTML = '<div class="tokfree-session-empty">本周暂无数据</div>';
      return;
    }
    listEl.innerHTML = list.map(w => {
      const win = nameMap[w.profileId] || providerMap[w.profileId] || w.profileId;
      const td = w.today || { sent: 0, received: 0, tokens: 0 };
      const wk = w.week || { sent: 0, received: 0, tokens: 0 };
      return '<div class="tokfree-usage-row">' +
        '<span class="tokfree-usage-win" title="' + win + '">' + win + '</span>' +
        '<span class="tokfree-usage-nums">今日 ' + (td.sent || 0) + '/' + (td.received || 0) +
        ' · 本周 ' + (wk.sent || 0) + '/' + (wk.received || 0) +
        ' · ' + formatTokens(wk.tokens) + '</span>' +
      '</div>';
    }).join('');
  } catch (err) {
    summaryEl.textContent = '读取失败';
    listEl.innerHTML = '<div class="tokfree-session-empty">加载失败</div>';
  }
}

/** 把 token 数格式化为易读字符串（1234 → 1.2k） */
function formatTokens(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/** YYYY-MM-DD */
function formatDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/** HH:mm:ss */
function formatTimeKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/**
 * 渲染最近 50 条事件日志到 #tokfree-stats-log
 */
async function renderStatsLog() {
  const logEl = document.getElementById('tokfree-stats-log');
  if (!logEl) return;
  try {
    if (!window.electronAPI || !window.electronAPI.getEventLog) {
      logEl.innerHTML = '<div class="tokfree-session-empty">不可用</div>';
      return;
    }
    const res = await window.electronAPI.getEventLog(50);
    const events = (res && res.success && res.events) || [];
    if (events.length === 0) {
      logEl.innerHTML = '<div class="tokfree-session-empty">暂无日志</div>';
      return;
    }
    // 窗口名映射
    const nameMap = {};
    try {
      const profilesRes = await window.electronAPI.listProfiles();
      (profilesRes && profilesRes.profiles || []).forEach(p => { nameMap[p.id] = p.name; });
    } catch (_) {}
    logEl.innerHTML = events.map(ev => {
      const time = formatTimeKey(ev.ts);
      const win = nameMap[ev.profileId] || ev.profileId || '-';
      const type = ev.sub ? (ev.type + ':' + ev.sub) : ev.type;
      const detail = ev.detail || '';
      return '<div class="tokfree-stats-log-item">' +
        '<span class="tokfree-stats-log-time">' + time + '</span>' +
        '<span class="tokfree-stats-log-win" title="' + win + '">' + win + '</span>' +
        '<span class="tokfree-stats-log-type">' + type + '</span>' +
        '<span class="tokfree-stats-log-detail" title="' + detail + '">' + detail + '</span>' +
      '</div>';
    }).join('');
  } catch (err) {
    logEl.innerHTML = '<div class="tokfree-session-empty">加载失败</div>';
  }
}

/**
 * 关闭窗口管理浮动面板
 */
function closeWindowManager() {
  const panel = document.getElementById('tokfree-window-manager');
  if (panel) panel.classList.add('tokfree-hidden');
  if (openWindowManager._timer) {
    clearInterval(openWindowManager._timer);
    openWindowManager._timer = null;
  }
}

/** 让窗口管理面板支持拖动（用 header 作拖拽手柄，transform 定位） */
/**
 * 让面板可缩放（支持四角手柄）
 * @param {HTMLElement} panel 面板
 * @param {HTMLElement[]} handles 角手柄数组（每个带 data-corner: se/sw/ne/nw）
 * @param {number} minW 最小宽
 * @param {number} minH 最小高
 */
function makeResizable(panel, handles, minW, minH) {
  if (!panel || !handles) return;
  const list = Array.isArray(handles) ? handles : [handles];
  const mw = minW || 260, mh = minH || 200;

  for (const handle of list) {
    if (!handle) continue;
    const corner = handle.dataset.corner || 'se';
    let resizing = false, startX = 0, startY = 0, startRect = null;

    handle.addEventListener('mousedown', (e) => {
      resizing = true;
      const rect = panel.getBoundingClientRect();
      // 转为 left/top 绝对定位（去掉 bottom/right 锚定），便于四角计算
      panel.style.transform = 'none';
      panel.style.bottom = 'auto';
      panel.style.right = 'auto';
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.width = rect.width + 'px';
      panel.style.height = rect.height + 'px';
      panel.style.maxHeight = 'none';
      startX = e.clientX; startY = e.clientY;
      startRect = { left: rect.left, top: rect.top, w: rect.width, h: rect.height };
      e.preventDefault(); e.stopPropagation();
    });

    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      let { left, top, w, h } = startRect;
      // 根据角决定方向
      if (corner === 'se') { w = startRect.w + dx; h = startRect.h + dy; }
      else if (corner === 'sw') { w = startRect.w - dx; h = startRect.h + dy; left = startRect.left + dx; }
      else if (corner === 'ne') { w = startRect.w + dx; h = startRect.h - dy; top = startRect.top + dy; }
      else if (corner === 'nw') { w = startRect.w - dx; h = startRect.h - dy; left = startRect.left + dx; top = startRect.top + dy; }
      // 约束最小尺寸（从左边/上边缩放时，需同时夹住 left/top）
      if (w < mw) {
        if (corner === 'sw' || corner === 'nw') left = startRect.left + (startRect.w - mw);
        w = mw;
      }
      if (h < mh) {
        if (corner === 'ne' || corner === 'nw') top = startRect.top + (startRect.h - mh);
        h = mh;
      }
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      panel.style.width = w + 'px';
      panel.style.height = h + 'px';
    });

    document.addEventListener('mouseup', () => { if (resizing) resizing = false; });
  }
}

function makeDraggable(panel, handle) {
  if (!panel || !handle) return;
  let dragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;
  handle.addEventListener("mousedown", (e) => {
    if (e.target && e.target.tagName === "BUTTON") return; // 点关闭按钮不拖动
    dragging = true;
    const rect = panel.getBoundingClientRect();
    // 切换为 left/top 绝对定位（去掉居中 transform + bottom/right 定位）
    panel.style.transform = "none";
    panel.style.bottom = "auto";
    panel.style.right = "auto";
    panel.style.left = rect.left + "px";
    panel.style.top = rect.top + "px";
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    handle.style.cursor = "grabbing";
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    panel.style.left = (startLeft + dx) + "px";
    panel.style.top = (startTop + dy) + "px";
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.style.cursor = "move";
  });
}


// ========== 窗口设置面板（账号/代理/指纹） ==========
let currentCfgProfileId = null;

/** 打开某窗口的设置面板 */
async function openProfileConfig(profileId) {
  currentCfgProfileId = profileId;
  const panel = document.getElementById('tokfree-profile-config');
  if (!panel) return;
  panel.classList.remove('tokfree-hidden');
  const nameEl = document.getElementById('tokfree-cfg-name');
  if (nameEl) {
    try {
      const res = await window.electronAPI.listProfiles();
      const p = (res && res.profiles || []).find(x => x.id === profileId);
      nameEl.textContent = p ? p.name : profileId;
    } catch (_) { nameEl.textContent = profileId; }
  }
  // 拉取配置
  try {
    const r = await window.electronAPI.getProfileConfig(profileId);
    if (r && r.success) {
      fillAccountForm(r.account || {});
      fillProxyForm(r.proxy || {});
      fillFingerprintForm(r.fingerprint || {});
    }
  } catch (err) {
    showToast('读取配置失败: ' + (err.message || err), 3000);
  }
}

function fillAccountForm(a) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? '' : v; };
  fillAccountBindOptions(a.accountId);
  set('tokfree-cfg-acct-label', a.label);
  set('tokfree-cfg-acct-email', a.email);
  set('tokfree-cfg-acct-group', a.group);
  set('tokfree-cfg-acct-status', a.status || 'active');
  set('tokfree-cfg-acct-quota', a.quotaLimit || 0);
}

function fillProxyForm(p) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? '' : v; };
  const chk = document.getElementById('tokfree-cfg-proxy-enabled');
  if (chk) chk.checked = !!p.enabled;
  set('tokfree-cfg-proxy-protocol', p.protocol || 'http');
  set('tokfree-cfg-proxy-host', p.host);
  set('tokfree-cfg-proxy-port', p.port || '');
  set('tokfree-cfg-proxy-user', p.username);
  set('tokfree-cfg-proxy-pass', p.password);
  const res = document.getElementById('tokfree-cfg-proxy-result');
  if (res) res.textContent = '';
}

function fillFingerprintForm(f) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? '' : v; };
  const chk = document.getElementById('tokfree-cfg-fp-enabled');
  if (chk) chk.checked = !!f.enabled;
  set('tokfree-cfg-fp-os', f.os || '');
  set('tokfree-cfg-fp-tz', f.timezone);
  set('tokfree-cfg-fp-lang', f.language);
  set('tokfree-cfg-fp-cores', f.hardwareConcurrency || '');
  set('tokfree-cfg-fp-sw', f.screenWidth || '');
  set('tokfree-cfg-fp-sh', f.screenHeight || '');
  // 记录完整身份（供保存时保留 webgl/seed）
  collectFingerprintForm._last = f || {};
  renderIdentityCard(f);
}

function collectProxyForm() {
  const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const chk = document.getElementById('tokfree-cfg-proxy-enabled');
  return {
    enabled: !!(chk && chk.checked),
    mode: 'fixed_servers',
    protocol: val('tokfree-cfg-proxy-protocol') || 'http',
    host: val('tokfree-cfg-proxy-host'),
    port: parseInt(val('tokfree-cfg-proxy-port'), 10) || 0,
    username: val('tokfree-cfg-proxy-user'),
    password: val('tokfree-cfg-proxy-pass'),
  };
}

/** 预置身份池：随机挑一套自然组合（系统/时区/语言/CPU/屏幕/显卡互相匹配） */
const IDENTITY_PRESETS = [
  { os: 'win', timezone: 'Asia/Shanghai', language: 'zh-CN', hardwareConcurrency: 8, screenWidth: 1920, screenHeight: 1080, webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { os: 'win', timezone: 'Asia/Shanghai', language: 'zh-CN', hardwareConcurrency: 16, screenWidth: 2560, screenHeight: 1440, webglVendor: 'Google Inc. (Intel)', webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { os: 'win', timezone: 'America/New_York', language: 'en-US', hardwareConcurrency: 12, screenWidth: 1920, screenHeight: 1080, webglVendor: 'Google Inc. (AMD)', webglRenderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { os: 'win', timezone: 'Europe/London', language: 'en-GB', hardwareConcurrency: 8, screenWidth: 1366, screenHeight: 768, webglVendor: 'Google Inc. (Intel)', webglRenderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { os: 'mac', timezone: 'America/Los_Angeles', language: 'en-US', hardwareConcurrency: 10, screenWidth: 2560, screenHeight: 1600, webglVendor: 'Google Inc. (Apple)', webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
  { os: 'mac', timezone: 'Asia/Tokyo', language: 'ja-JP', hardwareConcurrency: 8, screenWidth: 1920, screenHeight: 1200, webglVendor: 'Google Inc. (Apple)', webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
  { os: 'linux', timezone: 'Europe/Berlin', language: 'de-DE', hardwareConcurrency: 4, screenWidth: 1920, screenHeight: 1080, webglVendor: 'Google Inc. (Intel)', webglRenderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)' },
];

/** 当前真实系统（用于默认跟随，避免跨系统指纹矛盾导致白屏） */
function currentRealOs() {
  const p = (navigator.platform || '').toLowerCase();
  const ua = (navigator.userAgent || '').toLowerCase();
  if (p.indexOf('mac') !== -1 || ua.indexOf('macintosh') !== -1 || ua.indexOf('mac os') !== -1) return 'mac';
  if (p.indexOf('linux') !== -1 || ua.indexOf('linux') !== -1) return 'linux';
  return 'win';
}

/** 生成一套完整随机身份（默认只选与真实系统一致的，避免跨系统矛盾白屏） */
function generateRandomIdentity() {
  const realOs = currentRealOs();
  const pool = IDENTITY_PRESETS.filter(x => x.os === realOs);
  const list = pool.length > 0 ? pool : IDENTITY_PRESETS;
  const p = list[Math.floor(Math.random() * list.length)];
  return Object.assign({}, p, {
    enabled: true,
    seed: Math.floor(Math.random() * 1000000),
    deviceMemory: 8,
  });
}

/** 把身份对象填进表单 + 更新卡片 */
function renderIdentityCard(fp) {
  const card = document.getElementById('tokfree-cfg-fp-card');
  if (!card) return;
  if (!fp || !fp.seed) { card.textContent = '尚未生成身份'; return; }
  const osName = { win: 'Windows', mac: 'macOS', linux: 'Linux' }[fp.os] || (fp.os || '跟随系统');
  card.textContent =
    '系统: ' + osName + '\n' +
    '时区: ' + (fp.timezone || '-') + '\n' +
    '语言: ' + (fp.language || '-') + '\n' +
    'CPU: ' + (fp.hardwareConcurrency || '-') + ' 核\n' +
    '屏幕: ' + (fp.screenWidth || '-') + 'x' + (fp.screenHeight || '-') + '\n' +
    '显卡: ' + (fp.webglRenderer || '-').replace(/ANGLE \([^,]+, /, '').replace(/,.*/, '');
}

/** 解析代理地址字符串 → proxy 对象 */
function parseProxyUrl(str) {
  const s = (str || '').trim();
  if (!s) return null;
  let protocol = 'http', rest = s;
  const m = s.match(/^(https?|socks5?):\/\/(.+)$/i);
  if (m) {
    const p = m[1].toLowerCase();
    protocol = (p === 'socks' || p === 'socks5') ? 'socks5' : p;
    rest = m[2];
  }
  let username = '', password = '', host = '', port = 0;
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    const cred = rest.slice(0, at);
    rest = rest.slice(at + 1);
    const ci = cred.indexOf(':');
    if (ci !== -1) { username = decodeURIComponent(cred.slice(0, ci)); password = decodeURIComponent(cred.slice(ci + 1)); }
    else username = decodeURIComponent(cred);
  }
  const hp = rest.split(':');
  host = hp[0];
  port = parseInt(hp[1], 10) || 0;
  if (!host) return null;
  return { enabled: true, mode: 'fixed_servers', protocol, host, port, username, password };
}

function collectFingerprintForm() {
  const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const chk = document.getElementById('tokfree-cfg-fp-enabled');
  // 保留上次生成的身份细节（webgl/seed/deviceMemory），避免保存时丢失
  const prev = collectFingerprintForm._last || {};
  return {
    enabled: !!(chk && chk.checked),
    os: val('tokfree-cfg-fp-os'),
    timezone: val('tokfree-cfg-fp-tz'),
    language: val('tokfree-cfg-fp-lang'),
    hardwareConcurrency: parseInt(val('tokfree-cfg-fp-cores'), 10) || 0,
    screenWidth: parseInt(val('tokfree-cfg-fp-sw'), 10) || 0,
    screenHeight: parseInt(val('tokfree-cfg-fp-sh'), 10) || 0,
    webglVendor: prev.webglVendor || '',
    webglRenderer: prev.webglRenderer || '',
    deviceMemory: prev.deviceMemory || 8,
    seed: prev.seed || 0,
  };
}

/** 转义文本（任务清单内容防 XSS） */
function escapeTodoText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 渲染「任务清单」面板（读取当前窗口的 todo_write 列表） */
async function renderTodoList() {
  const list = document.getElementById('tokfree-todo-list');
  const progress = document.getElementById('tokfree-todo-progress');
  if (!list) return;
  try {
    if (!window.electronAPI || !window.electronAPI.getTodos) {
      list.innerHTML = '<div class="tokfree-session-empty">暂不支持</div>';
      return;
    }
    const res = await window.electronAPI.getTodos();
    const todos = (res && res.success && res.todos) || [];
    if (!todos.length) {
      list.innerHTML = '<div class="tokfree-session-empty">暂无任务</div>';
      if (progress) progress.textContent = '';
      return;
    }
    const done = todos.filter(t => t.status === 'completed').length;
    if (progress) progress.textContent = '（' + done + '/' + todos.length + '）';
    const ICON = { pending: '\u2610', in_progress: '\u25d0', completed: '\u2713' };
    list.innerHTML = todos.map(t => {
      const icon = ICON[t.status] || ICON.pending;
      const cls = t.status === 'completed' ? ' tokfree-todo-done'
        : (t.status === 'in_progress' ? ' tokfree-todo-active' : '');
      return '<div class="tokfree-todo-item' + cls + '">' +
        '<span class="tokfree-todo-icon">' + icon + '</span>' +
        '<span class="tokfree-todo-text">' + escapeTodoText(t.content) + '</span>' +
      '</div>';
    }).join('');
  } catch (err) {
    list.innerHTML = '<div class="tokfree-session-empty">加载失败</div>';
  }
}

/** 启动任务清单面板：首次渲染 + 刷新按钮 + 定时轮询（幂等） */
function startTodoPanel() {
  if (startTodoPanel._started) return;
  startTodoPanel._started = true;
  renderTodoList();
  const btn = document.getElementById('tokfree-todo-refresh');
  if (btn) btn.addEventListener('click', renderTodoList);
  setInterval(() => {
    const overlay = document.getElementById('tokfree-overlay');
    if (overlay && overlay.classList.contains('tokfree-hidden')) return;
    renderTodoList();
  }, 3000);
}

/** 绑定设置面板的所有事件（在 bindEvents 内调用一次） */
function bindProfileConfigEvents() {
  // tab 切换
  document.querySelectorAll('.tokfree-cfg-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      document.querySelectorAll('.tokfree-cfg-tab').forEach(t => t.classList.toggle('tokfree-cfg-tab-active', t === tab));
      document.querySelectorAll('.tokfree-cfg-pane').forEach(p => p.classList.toggle('tokfree-hidden', p.dataset.pane !== name));
    });
  });
  // 关闭
  document.getElementById('tokfree-cfg-close')?.addEventListener('click', () => {
    document.getElementById('tokfree-profile-config')?.classList.add('tokfree-hidden');
  });
  // 保存账号
  document.getElementById('tokfree-cfg-acct-save')?.addEventListener('click', async () => {
    if (!currentCfgProfileId) return;
    const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const account = {
      label: val('tokfree-cfg-acct-label'),
      email: val('tokfree-cfg-acct-email'),
      group: val('tokfree-cfg-acct-group'),
      status: val('tokfree-cfg-acct-status') || 'active',
      quotaLimit: parseInt(val('tokfree-cfg-acct-quota'), 10) || 0,
    };
    try {
      const r = await window.electronAPI.setProfileAccount(currentCfgProfileId, account);
      showToast(r && r.success ? '账号已保存' : ('保存失败: ' + ((r && r.error) || '未知')), 2500);
    } catch (err) { showToast('保存失败: ' + (err.message || err), 3000); }
  });
  // 测试代理
  document.getElementById('tokfree-cfg-proxy-test')?.addEventListener('click', async () => {
    if (!currentCfgProfileId) return;
    const resEl = document.getElementById('tokfree-cfg-proxy-result');
    if (resEl) resEl.textContent = '测试中…';
    try {
      const r = await window.electronAPI.testProfileProxy(currentCfgProfileId, collectProxyForm());
      if (resEl) resEl.textContent = r && r.success ? ('✔ 连通，出口 IP: ' + r.ip + '（' + r.ms + 'ms）') : ('✘ 失败: ' + ((r && r.error) || '未知'));
    } catch (err) {
      if (resEl) resEl.textContent = '✘ ' + (err.message || err);
    }
  });
  // 保存代理
  document.getElementById('tokfree-cfg-proxy-save')?.addEventListener('click', async () => {
    if (!currentCfgProfileId) return;
    try {
      const r = await window.electronAPI.setProfileProxy(currentCfgProfileId, collectProxyForm());
      showToast(r && r.success ? '代理已保存（已打开的窗口立即生效）' : ('保存失败: ' + ((r && r.error) || '未知')), 2800);
    } catch (err) { showToast('保存失败: ' + (err.message || err), 3000); }
  });
  // 一键生成随机身份
  document.getElementById('tokfree-cfg-fp-random')?.addEventListener('click', async () => {
    if (!currentCfgProfileId) return;
    const identity = generateRandomIdentity();
    try {
      const r = await window.electronAPI.setProfileFingerprint(currentCfgProfileId, identity);
      if (r && r.success) {
        fillFingerprintForm(identity);
        showToast('已生成新身份，点「保存并应用」后重启窗口生效', 3000);
      } else {
        showToast('生成失败: ' + ((r && r.error) || '未知'), 3000);
      }
    } catch (err) { showToast('生成失败: ' + (err.message || err), 3000); }
  });
  // 解析代理地址
  document.getElementById('tokfree-cfg-proxy-parse')?.addEventListener('click', () => {
    const inp = document.getElementById('tokfree-cfg-proxy-paste');
    const parsed = parseProxyUrl(inp ? inp.value : '');
    if (!parsed) { showToast('无法解析，请检查格式', 2500); return; }
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? '' : v; };
    set('tokfree-cfg-proxy-protocol', parsed.protocol);
    set('tokfree-cfg-proxy-host', parsed.host);
    set('tokfree-cfg-proxy-port', parsed.port);
    set('tokfree-cfg-proxy-user', parsed.username);
    set('tokfree-cfg-proxy-pass', parsed.password);
    const chk = document.getElementById('tokfree-cfg-proxy-enabled');
    if (chk) chk.checked = true;
    showToast('已解析：' + parsed.protocol + ' ' + parsed.host + ':' + parsed.port, 2500);
  });
  // 保存指纹
  document.getElementById('tokfree-cfg-fp-save')?.addEventListener('click', async () => {
    if (!currentCfgProfileId) return;
    try {
      const r = await window.electronAPI.setProfileFingerprint(currentCfgProfileId, collectFingerprintForm());
      showToast(r && r.success ? '指纹已保存（需重启窗口生效）' : ('保存失败: ' + ((r && r.error) || '未知')), 2800);
    } catch (err) { showToast('保存失败: ' + (err.message || err), 3000); }
  });
  // 换新身份
  document.getElementById('tokfree-cfg-fp-reseed')?.addEventListener('click', async () => {
    if (!currentCfgProfileId) return;
    try {
      const fp = collectFingerprintForm();
      fp.seed = Math.floor(Math.random() * 1000000);
      const r = await window.electronAPI.setProfileFingerprint(currentCfgProfileId, fp);
      showToast(r && r.success ? ('已换新身份 seed=' + fp.seed + '（重启窗口生效）') : ('失败: ' + ((r && r.error) || '未知')), 3000);
    } catch (err) { showToast('失败: ' + (err.message || err), 3000); }
  });
}

/**
 * 生成项目说明文档按钮点击处理
 */
async function handleGenerateDoc() {
  // 由当前项目目录算出 wing 名（与 project-context.js 的规则一致）
  const dir = state.currentProjectDir || '';
  const base = dir ? dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
  const wing = (base || 'general').replace(/[^a-zA-Z0-9]/g, '_') || 'general';

  const message = [
    '请完成两件事：',
    '1. 根据当前项目生成一个类似 claude.md 的项目说明文件，并将文件放到当前项目 .tokfreeCode/TOKFREE.md',
    '2. 文档生成后，把该项目的核心信息写入长期记忆（MemPalace）：',
    '   调用 mcpCall("mempalace", "mempalace_add_drawer", { content: "项目名/路径、技术栈、核心功能、关键约定与踩过的坑等简明摘要", wing: "' + wing + '" })',
    '   若 mempalace 未连接则跳过第 2 步，不要报错。',
  ].join('\n');
  try {
    const ok = await sendToChat(message, '生成文档', 300);
    if (!ok) {
      showToast('发送失败（未找到输入框或消息未发出），请确保已打开聊天界面', 3000);
    } else {
      showToast('已发送生成文档指令', 2200);
    }
  } catch (e) {
    showToast('发送失败: ' + ((e && e.message) || e), 3000);
  }
}

/**
 * 加载配置到 JSON 框
 */
async function loadMcpConfigToJson() {
  const res = await window.electronAPI.listMcpServers();
  const servers = res && res.success ? res.servers : [];
  // 转成主流 mcpServers 格式
  const mcpServers = {};
  for (const s of servers) {
    const def = {};
    if (s.type === 'http') {
      if (s.url) def.url = s.url;
      if (s.headers) def.headers = s.headers;
    } else {
      if (s.command) def.command = s.command;
      if (s.args && s.args.length) def.args = s.args;
      if (s.env) def.env = s.env;
    }
    mcpServers[s.name] = def;
  }
  const jsonInput = document.getElementById('tokfree-mcp-json');
  if (jsonInput) jsonInput.value = JSON.stringify({ mcpServers }, null, 2);
}

/**
 * 渲染 MCP server 列表
 */
async function renderMcpList() {
  const list = document.getElementById('tokfree-mcp-list');
  if (!list) return;
  try {
    const res = await window.electronAPI.listMcpServers();
    const servers = res && res.success ? res.servers : [];
    if (!servers || servers.length === 0) {
      list.innerHTML = '<div class="tokfree-session-empty">暂无 MCP Server</div>';
      return;
    }
    list.innerHTML = servers.map(s => {
      const status = s.connected ? '已连接' : (s.enabled ? '未连接' : '已禁用');
      const statusColor = s.connected ? '#4ade80' : (s.enabled ? '#ffc107' : '#5d6280');
      return '<div class="tokfree-window-item tokfree-mcp-item" data-mcp-name="' + s.name + '">' +
        '<span class="tokfree-window-name">' + s.name + '</span>' +
        '<span class="tokfree-mcp-dot" style="width:8px;height:8px;border-radius:50%;background:' + statusColor + ';flex-shrink:0;" title="' + status + '"></span>' +
      '</div>';
    }).join('');

    list.querySelectorAll('.tokfree-mcp-item').forEach(el => {
      el.addEventListener('click', async () => {
        const name = el.dataset.mcpName;
        const server = servers.find(s => s.name === name);
        if (!server) return;

        // 点击后立即显示 loading
        const dot = el.querySelector('.tokfree-mcp-dot');
        if (dot) dot.style.background = '#ffc107';
        el.style.pointerEvents = 'none';

        try {
          if (server.connected || server.enabled) {
            // 已连接或已启用 → 断开/禁用
            await window.electronAPI.disableMcpServer(name);
            showToast('已断开 ' + name, 2000);
          } else {
            // 未启用 → 连接
            await window.electronAPI.enableMcpServer(name);
            showToast('已连接 ' + name, 2000);
          }
          await renderMcpList();
          await loadMcpConfigToJson();
        } catch (err) {
          showToast('操作失败: ' + (err.message || err), 3000);
          await renderMcpList();
        }
      });
    });
  } catch (err) {
    list.innerHTML = '<div class="tokfree-session-empty">加载失败</div>';
  }
}

/**
 * 打开 MCP 管理面板
 */
function openMcpManager() {
  const panel = document.getElementById('tokfree-mcp-manager');
  if (panel) {
    panel.classList.remove('tokfree-hidden');
    renderMcpList();
    loadMcpConfigToJson();
  }
}

// ========== 知识库面板 ==========

// 当前知识库面板状态
let knowSkills = [];
let knowEnabled = [];
let knowSelected = null;

/**
 * 渲染技能列表（左栏）
 */
async function renderKnowledgePanel() {
  const list = document.getElementById('tokfree-know-list');
  if (!list) return;
  try {
    const res = await window.electronAPI.knowledgeList();
    if (!res || !res.success) {
      list.innerHTML = '<div class="tokfree-session-empty">加载失败</div>';
      updateKnowButtons();
      return;
    }
    knowSkills = res.skills || [];
    knowEnabled = res.enabled || [];
    if (knowSkills.length === 0) {
      list.innerHTML = '<div class="tokfree-session-empty">暂无技能</div>';
      updateKnowButtons();
      return;
    }
    const enabledSet = new Set(knowEnabled);
    list.innerHTML = knowSkills.map(s => {
      const on = enabledSet.has(s.name);
      const active = knowSelected === s.name ? ' tokfree-know-active' : '';
      const desc = s.description || '（无描述）';
      return '<div class="tokfree-window-item tokfree-know-item' + active + '" data-know-name="' + s.name + '">' +
        '<span class="tokfree-window-name tokfree-know-name" title="' + desc + '">' + s.name + '</span>' +
        '<span class="tokfree-know-toggle ' + (on ? 'on' : 'off') + '" data-know-toggle="' + s.name + '" title="' + (on ? '本项目已启用' : '本项目未启用') + '">' + (on ? '● 启用' : '○ 禁用') + '</span>' +
      '</div>';
    }).join('');

    // 点击技能项：选中并加载正文
    list.querySelectorAll('.tokfree-know-item').forEach(el => {
      el.addEventListener('click', async (e) => {
        if (e.target.classList.contains('tokfree-know-toggle')) return;
        const name = el.dataset.knowName;
        await selectKnowledgeSkill(name);
      });
    });
    // 点击启用/禁用开关
    list.querySelectorAll('.tokfree-know-toggle').forEach(el => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = el.dataset.knowToggle;
        const on = enabledSet.has(name);
        try {
          const r = on
            ? await window.electronAPI.knowledgeDisable(name)
            : await window.electronAPI.knowledgeEnable(name);
          if (r && r.success) {
            showToast(on ? '已在本项目禁用' : '已在本项目启用', 1800);
          } else {
            showToast((r && r.error) || '操作失败', 3000);
          }
        } catch (err) {
          showToast('操作失败: ' + (err.message || err), 3000);
        }
        await renderKnowledgePanel();
        // 更新启用按钮文案
        updateKnowButtons();
      });
    });
    // 渲染完成后同步按钮/输入框状态（修复：首次打开时"技能名输入框"未显示）
    updateKnowButtons();
  } catch (err) {
    list.innerHTML = '<div class="tokfree-session-empty">加载失败</div>';
    updateKnowButtons();
  }
}

/**
 * 选中某技能：加载正文到右侧
 */
async function selectKnowledgeSkill(name) {
  try {
    const res = await window.electronAPI.knowledgeRead(name);
    if (!res || !res.success) {
      showToast((res && res.error) || '读取失败', 3000);
      return;
    }
    knowSelected = name;
    const empty = document.getElementById('tokfree-know-empty');
    const nameInput = document.getElementById('tokfree-know-name');
    const content = document.getElementById('tokfree-know-content');
    if (empty) empty.classList.add('tokfree-hidden');
    if (nameInput) {
      nameInput.classList.add('tokfree-hidden');
      nameInput.value = name;
    }
    if (content) content.value = res.content || '';
    updateKnowButtons();
    // 刷新左栏高亮
    const list = document.getElementById('tokfree-know-list');
    if (list) {
      list.querySelectorAll('.tokfree-know-item').forEach(el => {
        el.classList.toggle('tokfree-know-active', el.dataset.knowName === name);
      });
    }
  } catch (err) {
    showToast('读取失败: ' + (err.message || err), 3000);
  }
}

/** 根据当前选中状态更新按钮显隐与启用按钮文案 */
function updateKnowButtons() {
  const saveBtn = document.getElementById('tokfree-know-save');
  const delBtn = document.getElementById('tokfree-know-delete');
  const toggleBtn = document.getElementById('tokfree-know-toggle-enabled');
  const content = document.getElementById('tokfree-know-content');
  const nameInput = document.getElementById('tokfree-know-name');
  const hasSel = !!knowSelected;
  if (saveBtn) saveBtn.classList.toggle('tokfree-hidden', !hasSel);
  if (delBtn) delBtn.classList.toggle('tokfree-hidden', !hasSel);
  if (toggleBtn) {
    toggleBtn.classList.toggle('tokfree-hidden', !hasSel);
    if (hasSel) {
      const on = knowEnabled.indexOf(knowSelected) !== -1;
      toggleBtn.textContent = on ? '在本项目禁用' : '在本项目启用';
    }
  }
  // 未选中时，右侧作为「新建」编辑区
  if (!hasSel) {
    if (content) content.value = '';
    if (nameInput) {
      nameInput.classList.remove('tokfree-hidden');
      nameInput.value = '';
    }
  }
}

/**
 * 打开知识库面板
 */
function openKnowledgeManager() {
  const panel = document.getElementById('tokfree-knowledge-manager');
  if (panel) {
    panel.classList.remove('tokfree-hidden');
    renderKnowledgePanel();
    loadPreferencesToPanel();
  }
}

/**
 * 关闭知识库面板
 */
function closeKnowledgeManager() {
  const panel = document.getElementById('tokfree-knowledge-manager');
  if (panel) panel.classList.add('tokfree-hidden');
}

/** 加载全局偏好到文本框 */
async function loadPreferencesToPanel() {
  const pref = document.getElementById('tokfree-know-pref');
  if (!pref) return;
  try {
    const res = await window.electronAPI.preferenceRead();
    if (res && res.success) pref.value = res.content || '';
  } catch (_) {}
}

/**
 * 关闭 MCP 管理面板
 */
function closeMcpManager() {
  const panel = document.getElementById('tokfree-mcp-manager');
  if (panel) panel.classList.add('tokfree-hidden');
}

/**
 * 格式化 token 数：过亿显示为「xxx亿」，过万显示为「xxx万」，否则原样显示
 */
function formatTokenCount(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '0';
  if (n >= 100000000) return (n / 100000000).toFixed(2) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(2) + '万';
  return String(n);
}

/**
 * 刷新面板里的「对话 Token」显示
 * 数据来源：服务端 accumulated_token_usage（含 prompt+输出）
 */
function updateConversationTokenDisplay() {
  const countEl = document.getElementById('tokfree-conv-token-count');
  if (!countEl) return;
  const server = state.serverTokenUsage;
  if (server && typeof server.accumulatedTokens === 'number') {
    countEl.textContent = formatTokenCount(server.accumulatedTokens);
    try { localStorage.setItem('tokfree-token-count', String(server.accumulatedTokens)); } catch (_) {}
  } else {
    const saved = parseFloat(localStorage.getItem('tokfree-token-count'));
    countEl.textContent = (isFinite(saved) && saved > 0) ? formatTokenCount(saved) : '0';
  }
}

// ========== 自动压缩上下文 ==========
// 配置：是否启用 + 阈值（单位：万 token）
let autoCompactEnabled = false;
let autoCompactThresholdWan = 80;
// 防止压缩过程中重复触发
let autoCompactTriggering = false;

/** 从 localStorage 读取自动压缩配置并同步到 UI */
function loadAutoCompactConfig() {
  try {
    const en = localStorage.getItem('tokfree-auto-compact-enabled');
    const th = localStorage.getItem('tokfree-auto-compact-threshold');
    autoCompactEnabled = en === '1';
    autoCompactThresholdWan = th ? (parseFloat(th) || 80) : 80;
  } catch (_) {}
  const enEl = document.getElementById('tokfree-auto-compact-enabled');
  const thEl = document.getElementById('tokfree-auto-compact-threshold');
  if (enEl) enEl.checked = autoCompactEnabled;
  if (thEl) thEl.value = autoCompactThresholdWan;
}

/** 保存自动压缩配置 */
function saveAutoCompactConfig() {
  const enEl = document.getElementById('tokfree-auto-compact-enabled');
  const thEl = document.getElementById('tokfree-auto-compact-threshold');
  const enabled = !!(enEl && enEl.checked);
  let th = thEl ? parseFloat(thEl.value) : 80;
  if (!Number.isFinite(th) || th <= 0) {
    showToast('阈值需为正数（万）', 3000);
    return;
  }
  autoCompactEnabled = enabled;
  autoCompactThresholdWan = th;
  try {
    localStorage.setItem('tokfree-auto-compact-enabled', enabled ? '1' : '0');
    localStorage.setItem('tokfree-auto-compact-threshold', String(th));
  } catch (_) {}
  showToast('自动压缩设置已保存：' + (enabled ? '开启，阈值 ' + th + ' 万' : '关闭'), 2500);
}

/**
 * 检查是否触发自动压缩
 * 数据源：state.serverTokenUsage.accumulatedTokens
 */
function checkAutoCompact() {
  if (autoCompactTriggering) return;
  // 需求B1：每次从 localStorage 重读开关与阈值，保证壳层右栏改动后即可生效
  try {
    autoCompactEnabled = localStorage.getItem('tokfree-auto-compact-enabled') === '1';
    var _th = parseFloat(localStorage.getItem('tokfree-auto-compact-threshold'));
    if (isFinite(_th) && _th > 0) autoCompactThresholdWan = _th;
  } catch (_) {}
  if (!autoCompactEnabled) return;
  const server = state.serverTokenUsage;
  let tokens = (server && typeof server.accumulatedTokens === 'number')
    ? server.accumulatedTokens
    : parseFloat(localStorage.getItem('tokfree-token-count'));
  if (!isFinite(tokens)) return;
  const thresholdTokens = autoCompactThresholdWan * 10000;
  if (tokens < thresholdTokens) return;
  autoCompactTriggering = true;
  console.log('[TokFree Compact] 自动触发：当前 ' + tokens + ' >= 阈值 ' + thresholdTokens);
  showToast('Token 超阈值（' + autoCompactThresholdWan + '万），自动压缩中...', 4000);
  runCompaction().finally(() => {
    autoCompactTriggering = false;
  });
}

/**
 * 启动对话 token 显示（每秒刷新）+ 自动压缩检查
 */
function startTokenCounter() {
  setInterval(() => {
    updateConversationTokenDisplay();
    checkAutoCompact();
  }, 1000);
  updateConversationTokenDisplay();
}

/**
 * 绑定覆盖层所有 UI 事件
 * 包括按钮点击、键盘快捷键、状态徽章点击等
 */
let eventsBound = false;
let mcpSending = false; // 防止 MCP 信息重复发送

// ========== Plan/Act 模式 + 操作确认 ==========
let policyMode = 'act';
let policyTrust = false;

/** 根据当前 policy 状态刷新 UI 文案 */
function renderPolicyUI() {
  const modeBtn = document.getElementById('tokfree-policy-mode');
  if (modeBtn) {
    const isPlan = policyMode === 'plan';
    modeBtn.textContent = '模式：' + (isPlan ? 'Plan' : 'Act') + '（点击切 ' + (isPlan ? 'Act' : 'Plan') + '）';
  }
  const trustChk = document.getElementById('tokfree-policy-trust');
  if (trustChk) trustChk.checked = policyTrust;
}

/** 初始化读取【全局】策略并同步 UI（设置面板展示的是全局默认） */
async function initPolicyUI() {
  try {
    if (!window.electronAPI) return;
    // 优先读全局默认（无则回退当前窗口值，兼容旧版本）
    let res = null;
    if (window.electronAPI.getPolicyGlobal) {
      res = await window.electronAPI.getPolicyGlobal();
    }
    if (!(res && res.success && res.policy)) {
      if (!window.electronAPI.getPolicy) return;
      res = await window.electronAPI.getPolicy();
    }
    const p = (res && res.success && res.policy) || (res && res.policy) || res || {};
    policyMode = p.mode === 'plan' ? 'plan' : 'act';
    policyTrust = p.confirmDangerous === false;
  } catch (_) {}
  renderPolicyUI();
}

/** 绑定 Plan/Act 切换 + 信任模式 + 确认弹窗监听 */
function bindPolicyEvents() {
  initPolicyUI();

  // 模式切换按钮（全局默认）
  const modeBtn = document.getElementById('tokfree-policy-mode');
  modeBtn?.addEventListener('click', async () => {
    const next = policyMode === 'plan' ? 'act' : 'plan';
    try {
      const fn = (window.electronAPI && window.electronAPI.setPolicyGlobalMode) || window.electronAPI.setPolicyMode;
      const r = await fn(next);
      if (r && r.success === false) { showToast('切换失败: ' + (r.error || '未知'), 3000); return; }
      policyMode = next;
      renderPolicyUI();
      showToast('已切换全局模式到 ' + (next === 'plan' ? 'Plan（只读规划）' : 'Act（正常执行）') + '（影响所有标签页）', 2600);
    } catch (err) {
      showToast('切换失败: ' + (err.message || err), 3000);
    }
  });

  // 信任模式复选框（全局默认）
  const trustChk = document.getElementById('tokfree-policy-trust');
  trustChk?.addEventListener('change', async () => {
    const trustChecked = !!trustChk.checked;      // 勾选 = 信任 = 免确认
    const confirmDangerous = !trustChecked;       // 传给后端的是「是否需要确认」（信任时不需要确认）
    try {
      const fn = (window.electronAPI && window.electronAPI.setPolicyGlobalTrust) || window.electronAPI.setPolicyTrust;
      const r = await fn(confirmDangerous);
      if (r && r.success === false) { showToast('保存失败: ' + (r.error || '未知'), 3000); return; }
      policyTrust = trustChecked;
      showToast((trustChecked ? '全局信任模式：危险操作免确认' : '全局信任模式关闭：危险操作需确认') + '（影响所有标签页）', 2600);
    } catch (err) {
      showToast('保存失败: ' + (err.message || err), 3000);
    }
  });

  // 操作确认弹窗监听
  if (window.electronAPI && window.electronAPI.onToolConfirm) {
    window.electronAPI.onToolConfirm(async (payload) => {
      const { requestId, tool, params, reason } = payload || {};
      const text = 'AI 想执行【' + (tool || '?') + '】操作：' + (reason || '（无说明）') +
        '\n\n是否允许？';
      let ok = false;
      try {
        ok = await showConfirmDialog(text, { okText: '允许', showCancel: true, cancelText: '拒绝' });
      } catch (_) {
        ok = false;
      }
      try {
        await window.electronAPI.respondToolConfirm(requestId, ok);
      } catch (_) {}
    });
  }
}


// ========== 账号池面板 ==========
let acctAccounts = [];
let acctSelected = null;

/** 渲染账号池列表（左栏） */
async function renderAccountPool() {
  const list = document.getElementById('tokfree-acct-list');
  if (!list) return;
  try {
    const res = await window.electronAPI.listAccounts();
    if (!res || !res.success) {
      list.innerHTML = '<div class="tokfree-session-empty">加载失败</div>';
      updateAcctButtons();
      return;
    }
    acctAccounts = res.accounts || [];
    if (acctAccounts.length === 0) {
      list.innerHTML = '<div class="tokfree-session-empty">暂无账号</div>';
      updateAcctButtons();
      return;
    }
    // 拉取占用情况，在列表里标注"已被窗口 X 使用"
    let usage = {};
    try {
      const u = window.electronAPI.listAccountUsage ? await window.electronAPI.listAccountUsage() : null;
      if (u && u.success) usage = u.usage || {};
    } catch (_) {}
    list.innerHTML = acctAccounts.map(a => {
      const active = acctSelected === a.id ? ' tokfree-acct-active' : '';
      const usedBy = usage[a.id] || [];
      const usedTag = usedBy.length > 0 ? ' · 已被 ' + usedBy.map(u => u.profileName || u.profileId).join(', ') + ' 使用' : '';
      const sub = (a.username || '') + (a.providerId ? ' · ' + a.providerId : '') + (a.hasPassword ? '' : ' · 无密码') + usedTag;
      return '<div class="tokfree-window-item tokfree-acct-item' + active + '" data-acct-id="' + a.id + '">' +
        '<span class="tokfree-window-left">' +
          '<span class="tokfree-window-name tokfree-acct-name" title="' + (a.label || a.username || a.id) + '">' + (a.label || '(未命名)') + '</span>' +
          '<span class="tokfree-acct-sub" title="' + sub + '">' + sub + '</span>' +
        '</span>' +
      '</div>';
    }).join('');
    list.querySelectorAll('.tokfree-acct-item').forEach(el => {
      el.addEventListener('click', () => selectAccount(el.dataset.acctId));
    });
    updateAcctButtons();
  } catch (err) {
    list.innerHTML = '<div class="tokfree-session-empty">加载失败</div>';
    updateAcctButtons();
  }
}

/** 选中账号并填充表单 */
async function selectAccount(id) {
  const a = acctAccounts.find(x => x.id === id);
  if (!a) return;
  acctSelected = id;
  const set = (eid, v) => { const el = document.getElementById(eid); if (el) el.value = v == null ? '' : v; };
  set('tokfree-acct-label', a.label);
  set('tokfree-acct-username', a.username);
  set('tokfree-acct-password', '');
  set('tokfree-acct-provider', a.providerId);
  set('tokfree-acct-group', a.group);
  set('tokfree-acct-note', a.note);
  const empty = document.getElementById('tokfree-acct-empty');
  if (empty) empty.classList.add('tokfree-hidden');
  const list = document.getElementById('tokfree-acct-list');
  if (list) list.querySelectorAll('.tokfree-acct-item').forEach(el => el.classList.toggle('tokfree-acct-active', el.dataset.acctId === id));
  updateAcctButtons();
}

/** 清空表单进入新建态 */
function clearAccountForm() {
  acctSelected = null;
  ['tokfree-acct-label','tokfree-acct-username','tokfree-acct-password','tokfree-acct-provider','tokfree-acct-group','tokfree-acct-note'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const empty = document.getElementById('tokfree-acct-empty');
  if (empty) empty.classList.remove('tokfree-hidden');
  const list = document.getElementById('tokfree-acct-list');
  if (list) list.querySelectorAll('.tokfree-acct-item').forEach(el => el.classList.remove('tokfree-acct-active'));
  updateAcctButtons();
}

function updateAcctButtons() {
  const delBtn = document.getElementById('tokfree-acct-delete');
  if (delBtn) delBtn.classList.toggle('tokfree-hidden', !acctSelected);
}

/** 保存（选中则更新，否则新建） */
async function saveAccountForm() {
  const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const base = {
    label: val('tokfree-acct-label'),
    username: val('tokfree-acct-username'),
    providerId: val('tokfree-acct-provider'),
    group: val('tokfree-acct-group'),
    note: val('tokfree-acct-note'),
  };
  const pwd = val('tokfree-acct-password');
  try {
    if (acctSelected) {
      const patch = Object.assign({}, base);
      if (pwd) patch.password = pwd;
      const r = await window.electronAPI.updateAccount(acctSelected, patch);
      if (r && r.success) {
        showToast(r.warning ? ('已保存（' + r.warning + '）') : '账号已保存', 2500);
        await renderAccountPool();
        selectAccount(acctSelected);
      } else {
        showToast((r && r.error) || '保存失败', 3000);
      }
    } else {
      if (!base.username) { showToast('请填写登录名', 3000); return; }
      if (!base.providerId) { showToast('请填写平台（providerId）', 3000); return; }
      const data = Object.assign({}, base);
      if (pwd) data.password = pwd;
      const r = await window.electronAPI.createAccount(data);
      if (r && r.success) {
        showToast(r.warning ? ('已创建（' + r.warning + '）') : '账号已创建', 2500);
        await renderAccountPool();
        if (r.id) selectAccount(r.id);
      } else {
        showToast((r && r.error) || '创建失败', 3000);
      }
    }
  } catch (err) {
    showToast('保存失败: ' + (err.message || err), 3000);
  }
}

async function deleteSelectedAccount() {
  if (!acctSelected) return;
  const ok = await showConfirmDialog('确定删除该账号？此操作不可恢复。', { okText: '删除', showCancel: true, cancelText: '取消' });
  if (!ok) return;
  try {
    const r = await window.electronAPI.deleteAccount(acctSelected);
    if (r && r.success) {
      showToast('已删除', 1800);
      clearAccountForm();
      await renderAccountPool();
    } else {
      showToast((r && r.error) || '删除失败', 3000);
    }
  } catch (err) {
    showToast('删除失败: ' + (err.message || err), 3000);
  }
}

function openAccountPool() {
  const panel = document.getElementById('tokfree-account-pool');
  if (panel) {
    panel.classList.remove('tokfree-hidden');
    renderAccountPool();
  }
}
function closeAccountPool() {
  const panel = document.getElementById('tokfree-account-pool');
  if (panel) panel.classList.add('tokfree-hidden');
}

/** 填充窗口设置-账号 tab 的「绑定账号池账号」下拉 */
async function fillAccountBindOptions(currentAccountId) {
  const sel = document.getElementById('tokfree-cfg-acct-bind');
  if (!sel) return;
  try {
    const res = await window.electronAPI.listAccounts();
    const accounts = (res && res.success && res.accounts) || [];
    sel.innerHTML = '<option value="">（不绑定）</option>' +
      accounts.map(a => '<option value="' + a.id + '">' + ((a.label || a.username || a.id) + (a.providerId ? ' · ' + a.providerId : '')) + '</option>').join('');
    sel.value = currentAccountId || '';
  } catch (_) {
    sel.innerHTML = '<option value="">（加载失败）</option>';
  }
}

/**
 * 需要用户从账号池选择账号（进入登录页且未绑定/登录失败时触发）
 * 弹真正的账号选择弹窗：列表选择 + 占用标记（已被其他窗口使用的置灰）
 */
async function promptAccountSelect(payload) {
  const { profileId, reason, providerId } = payload || {};
  if (!profileId) return;
  try {
    // 解析该窗口的平台标识：优先用 payload 携带的 providerId，
    // 否则反查 profile（兼容旧的 account-relogin-failed 事件）
    let pid = providerId || '';
    if (!pid) {
      try {
        const pr = await window.electronAPI.listProfiles();
        const profiles = (pr && pr.success && pr.profiles) || [];
        const me = profiles.find(p => p.id === profileId);
        if (me) pid = me.providerId || '';
      } catch (_) {}
    }
    const [acctRes, usageRes] = await Promise.all([
      window.electronAPI.listAccounts(pid || undefined),
      window.electronAPI.listAccountUsage ? window.electronAPI.listAccountUsage() : Promise.resolve({ success: true, usage: {} }),
    ]);
    const accounts = (acctRes && acctRes.success && acctRes.accounts) || [];
    const usage = (usageRes && usageRes.success && usageRes.usage) || {};
    if (accounts.length === 0) {
      showToast('账号池中没有该平台的可用账号，请先在「账号池」面板添加', 4000);
      return;
    }
    const chosenId = await showAccountSelectDialog({
      reason: reason || '该窗口需要登录，请选择账号',
      accounts,
      usage,
      currentProfileId: profileId,
    });
    if (!chosenId) return;
    const r = await window.electronAPI.respondReloginSelect(profileId, chosenId);
    showToast(r && r.success ? '已用所选账号登录中…' : ('登录失败: ' + ((r && r.error) || '未知')), 3000);
  } catch (err) {
    showToast('选择账号失败: ' + (err.message || err), 3000);
  }
}

/** 绑定账号池面板事件（在 bindEvents 内调用一次） */
function bindAccountPoolEvents() {
  document.getElementById('tokfree-btn-account-pool')?.addEventListener('click', openAccountPool);
  document.getElementById('tokfree-acct-close')?.addEventListener('click', closeAccountPool);
  document.getElementById('tokfree-acct-refresh')?.addEventListener('click', renderAccountPool);
  document.getElementById('tokfree-acct-new')?.addEventListener('click', clearAccountForm);
  document.getElementById('tokfree-acct-save')?.addEventListener('click', saveAccountForm);
  document.getElementById('tokfree-acct-delete')?.addEventListener('click', deleteSelectedAccount);
  // 绑定下拉变化 → 写入 profile
  document.getElementById('tokfree-cfg-acct-bind')?.addEventListener('change', async (e) => {
    if (!currentCfgProfileId) return;
    try {
      const r = await window.electronAPI.bindAccount(currentCfgProfileId, e.target.value || '');
      showToast(r && r.success ? '已绑定账号，正在尝试自动登录…' : ('绑定失败: ' + ((r && r.error) || '未知')), 2200);
    } catch (err) { showToast('绑定失败: ' + (err.message || err), 3000); }
  });
  // 立即重登：手动触发该窗口的登录检查（用于测试/失败重试）
  document.getElementById('tokfree-cfg-acct-relogin')?.addEventListener('click', async () => {
    if (!currentCfgProfileId) return;
    showToast('正在尝试自动登录…', 2000);
    try {
      const r = await window.electronAPI.triggerRelogin(currentCfgProfileId);
      if (r && r.success) {
        const res = r.result || {};
        if (res.relogged) showToast('自动登录成功 ✓', 2500);
        else if (res.needSelect) showToast('未绑定账号或密码缺失，请从账号池选择', 3000);
        else if (res.error) showToast('自动登录失败: ' + res.error, 3500);
        else showToast('当前不在登录页，无需重登', 2500);
      } else {
        showToast('触发失败: ' + ((r && r.error) || '未知'), 3000);
      }
    } catch (err) { showToast('触发失败: ' + (err.message || err), 3000); }
  });
  // 需要选号监听（进入登录页且未绑定/登录失败 → 弹真正的选择弹窗）
  if (window.electronAPI && window.electronAPI.onNeedAccountSelect) {
    window.electronAPI.onNeedAccountSelect(promptAccountSelect);
  }
  // 兼容旧事件（保留）
  if (window.electronAPI && window.electronAPI.onReloginFailed) {
    window.electronAPI.onReloginFailed(promptAccountSelect);
  }
}

function bindEvents() {
  // 防止重复绑定（SPA 导航或 preload 重载时可能导致多次执行）
  if (eventsBound) return;
  eventsBound = true;

  bindAccountPoolEvents();

  // 从全局设置恢复延迟配置（跨标签共享）；IPC 不可用时降级用 localStorage
  try {
    var minInput = document.getElementById('tokfree-delay-min');
    var maxInput = document.getElementById('tokfree-delay-max');
    var applyDelay = function (mn, mx) {
      state.sendDelayMin = mn;
      state.sendDelayMax = mx;
      if (minInput) minInput.value = mn;
      if (maxInput) maxInput.value = mx;
    };
    var readLocalDelay = function () {
      var sMin = parseInt(localStorage.getItem('tokfree-send-delay-min'), 10);
      var sMax = parseInt(localStorage.getItem('tokfree-send-delay-max'), 10);
      if (isNaN(sMin) || sMin < 0) sMin = 4000;
      if (isNaN(sMax) || sMax < sMin) sMax = 6000;
      return { min: sMin, max: sMax };
    };
    if (window.electronAPI && window.electronAPI.getSendDelay) {
      window.electronAPI.getSendDelay().then(function (r) {
        if (r && r.success) applyDelay(r.min, r.max);
        else { var d = readLocalDelay(); applyDelay(d.min, d.max); }
      }).catch(function () {
        var d = readLocalDelay(); applyDelay(d.min, d.max);
      });
    } else {
      var d0 = readLocalDelay(); applyDelay(d0.min, d0.max);
    }
  } catch (e) {}

  // 小面板拖动 + 缩放（记住位置/尺寸）
  try {
    const overlayPanel = document.getElementById('tokfree-overlay');
    const overlayHeader = overlayPanel && overlayPanel.querySelector('.tokfree-header');
    const overlayResizeHandles = Array.from(document.querySelectorAll('.tokfree-resize-handle'));
    if (overlayPanel && overlayHeader) {
      makeDraggable(overlayPanel, overlayHeader);
      // 恢复上次位置/尺寸
      try {
        const saved = JSON.parse(localStorage.getItem('tokfree-overlay-geom') || 'null');
        if (saved) {
          if (saved.left != null) { overlayPanel.style.left = saved.left + 'px'; overlayPanel.style.top = saved.top + 'px'; overlayPanel.style.bottom = 'auto'; overlayPanel.style.right = 'auto'; overlayPanel.style.transform = 'none'; }
          if (saved.w) { overlayPanel.style.width = saved.w + 'px'; }
          if (saved.h) { overlayPanel.style.height = saved.h + 'px'; overlayPanel.style.maxHeight = saved.h + 'px'; }
        }
      } catch (_) {}
      // 拖动/缩放结束后保存
      const saveGeom = () => {
        try {
          const rect = overlayPanel.getBoundingClientRect();
          localStorage.setItem('tokfree-overlay-geom', JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) }));
        } catch (_) {}
      };
      document.addEventListener('mouseup', saveGeom);
    }
    if (overlayPanel && overlayResizeHandles.length) makeResizable(overlayPanel, overlayResizeHandles, 260, 220);
  } catch (_) {}

  // 设置抽屉：打开/关闭 + 读写设置
  const settingsBtn = document.getElementById('tokfree-btn-settings');
  const settingsDrawer = document.getElementById('tokfree-settings-drawer');
  const settingsClose = document.getElementById('tokfree-settings-close');
  const loadSettings = () => {
    const get = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
    const notifyEl = document.getElementById('tokfree-set-notify');
    const retryEl = document.getElementById('tokfree-set-retry');
    const retryCntEl = document.getElementById('tokfree-set-retry-count');
    const wdTimeoutEl = document.getElementById('tokfree-set-wd-timeout');
    const guardEl = document.getElementById('tokfree-set-guard');
    if (notifyEl) notifyEl.checked = get('tokfree-notify-enabled', '1') === '1';
    if (retryEl) retryEl.checked = get('tokfree-retry-enabled', '1') === '1';
    if (retryCntEl) retryCntEl.value = get('tokfree-retry-count', '10');
    if (wdTimeoutEl) wdTimeoutEl.value = Math.round(parseInt(get('tokfree-xhr-idle-timeout', '300000'), 10) / 1000) || 300;
    if (guardEl) guardEl.checked = get('tokfree-guard-enabled', '1') === '1';
    // 生命监护真实状态从主进程读
    try {
      if (window.electronAPI.watchdogGetConfig && guardEl) {
        window.electronAPI.watchdogGetConfig().then((r) => {
          if (r && r.success && r.config) guardEl.checked = !!r.config.enabled;
        }).catch(() => {});
      }
    } catch (_) {}
    // 引导者（Curator）：从主进程读真实配置
    try {
      if (window.electronAPI.curatorGetConfig) {
        window.electronAPI.curatorGetConfig().then((r) => {
          if (!r || !r.success || !r.status) return;
          const c = r.status.config || {};
          const col = c.collect || {};
          const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
          const setVal = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
          setChk('tokfree-set-curator', c.enabled);
          setVal('tokfree-set-curator-idle', c.idleMinutes);
          setVal('tokfree-set-curator-gap', c.minIntervalMinutes);
          setVal('tokfree-set-curator-props', c.maxProposals);
          const pe = document.getElementById('tokfree-set-curator-prompt');
          if (pe) pe.value = c.briefPrompt || '';
          setChk('tokfree-cur-col-git', col.git);
          setChk('tokfree-cur-col-todos', col.todos);
          setChk('tokfree-cur-col-lessons', col.lessons);
          setChk('tokfree-cur-col-skills', col.skills);
          setChk('tokfree-cur-col-goals', col.goals);
          const hint = document.getElementById('tokfree-curator-hint');
          if (hint) hint.textContent = r.status.idle ? '当前：系统空闲中' : '当前：系统忙碌中';
        }).catch(() => {});
      }
    } catch (_) {}
    // 自进化飞轮总开关：从主进程读真实配置
    try {
      if (window.electronAPI.evolutionGetConfig) {
        window.electronAPI.evolutionGetConfig().then((r) => {
          if (!r || !r.success || !r.config) return;
          const el = document.getElementById('tokfree-set-evolution');
          if (el) el.checked = !!r.config.enabled;
        }).catch(() => {});
      }
    } catch (_) {}
    // 本地 OpenAI 兼容 API：从主进程读真实配置 + 状态
    // 注意：覆盖层（悬浮球/悬浮窗）已彻底禁用（ui.js showOverlay→hideOverlay），
    // 此处的开关不会生效；实际开关位于壳层设置弹窗（shell.html #ssm-set-apiserver）。
    // 保留仅为兼容旧代码路径。
    try {
      if (window.electronAPI.apiServerGet) {
        window.electronAPI.apiServerGet().then((r) => {
          if (!r || !r.success) return;
          const cfg = r.config || {};
          const enEl = document.getElementById('tokfree-set-apiserver');
          const portEl = document.getElementById('tokfree-set-apiserver-port');
          if (enEl) enEl.checked = !!cfg.enabled;
          if (portEl && cfg.port) portEl.value = cfg.port;
          const st = r.status || {};
          const stEl = document.getElementById('tokfree-apiserver-status');
          if (stEl) stEl.textContent = st.running ? ('已启动 http://' + (st.host || '127.0.0.1') + ':' + (st.port || cfg.port) + '/v1') : '未启用';
        }).catch(() => {});
      }
    } catch (_) {}
    // ShardX 反检测浏览器：查询就位状态
    try {
      if (window.electronAPI.shardxStatus) {
        window.electronAPI.shardxStatus().then((r) => {
          const el = document.getElementById('tokfree-shardx-status');
          if (!el) return;
          if (!r || !r.success) { el.textContent = '状态查询失败'; return; }
          const s = r.status || {};
          let txt;
          if (!s.installed && !s.mcpReady) txt = '未就位';
          else if (s.installed && s.mcpReady && s.mcpConfigured) txt = '已就绪';
          else if (s.installed && s.mcpReady) txt = '已就位（MCP 待写入）';
          else if (s.installed) txt = 'Launcher 已装（MCP 待就位）';
          else txt = '安装中';
          el.textContent = txt;
          if (s.launcherExePath) el.title = s.launcherExePath;
        }).catch(() => {});
      }
    } catch (_) {}
  };
  const saveSettings = () => {
    const set = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
    const notifyEl = document.getElementById('tokfree-set-notify');
    const retryEl = document.getElementById('tokfree-set-retry');
    const retryCntEl = document.getElementById('tokfree-set-retry-count');
    const wdTimeoutEl = document.getElementById('tokfree-set-wd-timeout');
    const guardEl = document.getElementById('tokfree-set-guard');
    if (notifyEl) set('tokfree-notify-enabled', notifyEl.checked ? '1' : '0');
    if (retryEl) set('tokfree-retry-enabled', retryEl.checked ? '1' : '0');
    if (retryCntEl) set('tokfree-retry-count', String(parseInt(retryCntEl.value, 10) || 0));
    if (wdTimeoutEl) set('tokfree-xhr-idle-timeout', String((parseInt(wdTimeoutEl.value, 10) || 0) * 1000));
    if (guardEl) {
      set('tokfree-guard-enabled', guardEl.checked ? '1' : '0');
      try { if (window.electronAPI.watchdogSetEnabled) window.electronAPI.watchdogSetEnabled(guardEl.checked); } catch (_) {}
    }
    // 引导者（Curator）：写入主进程配置
    try {
      if (window.electronAPI.curatorSetConfig) {
        const getChk = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };
        const getNum = (id, d) => { const el = document.getElementById(id); const v = el ? parseInt(el.value, 10) : NaN; return Number.isFinite(v) ? v : d; };
        const pe = document.getElementById('tokfree-set-curator-prompt');
        const patch = {
          enabled: getChk('tokfree-set-curator'),
          idleMinutes: getNum('tokfree-set-curator-idle', 30),
          minIntervalMinutes: getNum('tokfree-set-curator-gap', 60),
          maxProposals: getNum('tokfree-set-curator-props', 3),
          briefPrompt: pe ? pe.value : '',
          collect: {
            git: getChk('tokfree-cur-col-git'),
            todos: getChk('tokfree-cur-col-todos'),
            lessons: getChk('tokfree-cur-col-lessons'),
            skills: getChk('tokfree-cur-col-skills'),
            goals: getChk('tokfree-cur-col-goals'),
          },
        };
        window.electronAPI.curatorSetConfig(patch).catch(() => {});
      }
    } catch (_) {}
    // 自进化飞轮总开关：写入主进程
    try {
      if (window.electronAPI.evolutionSetConfig) {
        const evEl = document.getElementById('tokfree-set-evolution');
        window.electronAPI.evolutionSetConfig({ enabled: evEl ? evEl.checked : false }).catch(() => {});
      }
    } catch (_) {}
    // 本地 OpenAI 兼容 API：写入配置并起停服务
    // 注意：覆盖层已禁用，此逻辑不会执行；实际开关在壳层设置弹窗。
    try {
      if (window.electronAPI.apiServerSet) {
        const enEl = document.getElementById('tokfree-set-apiserver');
        const portEl = document.getElementById('tokfree-set-apiserver-port');
        const portVal = portEl ? parseInt(portEl.value, 10) : NaN;
        const patch = { enabled: enEl ? enEl.checked : false };
        if (Number.isFinite(portVal) && portVal > 0) patch.port = portVal;
        window.electronAPI.apiServerSet(patch).then((r) => {
          if (!r || !r.success) { showToast('API 服务设置失败: ' + ((r && r.error) || '未知'), 3000); return; }
          const st = r.status || {};
          const stEl = document.getElementById('tokfree-apiserver-status');
          if (stEl) stEl.textContent = st.running ? ('已启动 http://' + (st.host || '127.0.0.1') + ':' + (st.port || patch.port) + '/v1') : '未启用';
        }).catch((e) => { showToast('API 服务设置异常: ' + (e.message || e), 3000); });
      }
    } catch (_) {}
    showToast('设置已保存（部分需重启生效）', 2200);
  };
  settingsBtn?.addEventListener('click', () => {
    if (settingsDrawer) {
      settingsDrawer.classList.toggle('tokfree-hidden');
      if (!settingsDrawer.classList.contains('tokfree-hidden')) {
        loadSettings();
        // 居中弹窗：首次打开时绑定标题栏拖动（幂等）
        if (!settingsDrawer._dragInit) {
          settingsDrawer._dragInit = true;
          const hd = settingsDrawer.querySelector('.tokfree-wm-header');
          if (hd) makeDraggable(settingsDrawer, hd);
        }
      }
    }
  });
  settingsClose?.addEventListener('click', () => {
    if (settingsDrawer) settingsDrawer.classList.add('tokfree-hidden');
  });
  document.getElementById('tokfree-btn-save-settings')?.addEventListener('click', saveSettings);

  // ===== 多 Agent 模式开关（之前漏绑定！）=====
  (function initTeamModeToggle() {
    const toggle = document.getElementById('tokfree-team-mode-toggle');
    if (!toggle) return;
    // 读取当前模式
    try {
      if (window.electronAPI && window.electronAPI.getTeamMode) {
        window.electronAPI.getTeamMode().then(function (r) {
          if (r && r.success) toggle.checked = (r.mode === 'multi');
        }).catch(function () {});
      }
    } catch (_) {}
    // 切换模式
    toggle.addEventListener('change', async function () {
      const mode = toggle.checked ? 'multi' : 'single';
      try {
        if (window.electronAPI && window.electronAPI.setTeamMode) {
          const r = await window.electronAPI.setTeamMode(mode);
          if (r && r.success) {
            showToast(mode === 'multi' ? '已开启多 Agent 模式（本窗口为主大脑）' : '已回到单聊模式', 2500);
            if (typeof renderWindowList === 'function') renderWindowList();
          } else {
            showToast('切换失败: ' + ((r && r.error) || '未知'), 3000);
            toggle.checked = !toggle.checked;
          }
        }
      } catch (e) {
        showToast('切换异常: ' + (e.message || e), 3000);
        toggle.checked = !toggle.checked;
      }
    });
  })();

  // 关于按钮
  document.getElementById('tokfree-btn-about')?.addEventListener('click', function () {
    try { require('./about').openAbout(); } catch (_) {}
  });

  // 检查更新按钮
  document.getElementById('tokfree-btn-check-update')?.addEventListener('click', async function () {
    try {
      showToast('正在检查更新…', 2500);
      if (!window.electronAPI || typeof window.electronAPI.checkUpdate !== 'function') {
        showToast('当前环境不支持检查更新', 3000);
        return;
      }
      const r = await window.electronAPI.checkUpdate();
      if (r && r.success === false) showToast('检查更新失败: ' + (r.error || '未知'), 3000);
    } catch (err) {
      showToast('检查更新失败: ' + (err.message || err), 3000);
    }
  });

  // 引导者：立即巡检一次
  document.getElementById('tokfree-btn-curator-now')?.addEventListener('click', async () => {
    const hint = document.getElementById('tokfree-curator-hint');
    try {
      if (!window.electronAPI.curatorTriggerNow) return;
      if (hint) hint.textContent = '正在采集并注入…';
      const r = await window.electronAPI.curatorTriggerNow();
      if (r && r.success) { if (hint) hint.textContent = '已注入战略巡检简报'; showToast('已发起战略巡检', 2500); }
      else { if (hint) hint.textContent = '失败：' + ((r && r.error) || '未知'); showToast('巡检失败: ' + ((r && r.error) || '未知'), 3000); }
    } catch (e) {
      if (hint) hint.textContent = '出错：' + (e && e.message);
    }
  });

  // 主题切换按钮
  const themeBtn = document.getElementById('tokfree-btn-theme');
  const syncThemeIcon = () => {
    if (!themeBtn) return;
    try {
      const t = require('./ui').getSavedTheme ? require('./ui').getSavedTheme() : 'dark';
      themeBtn.innerHTML = t === 'light' ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;pointer-events:none;"><circle cx="12" cy="12" r="4.5"/><line x1="12" y1="1.5" x2="12" y2="3.5"/><line x1="12" y1="20.5" x2="12" y2="22.5"/><line x1="3.9" y1="3.9" x2="5.3" y2="5.3"/><line x1="18.7" y1="18.7" x2="20.1" y2="20.1"/><line x1="1.5" y1="12" x2="3.5" y2="12"/><line x1="20.5" y1="12" x2="22.5" y2="12"/><line x1="3.9" y1="20.1" x2="5.3" y2="18.7"/><line x1="18.7" y1="5.3" x2="20.1" y2="3.9"/></svg>' : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;pointer-events:none;"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
      themeBtn.title = t === 'light' ? '切换到暗色主题' : '切换到亮色主题';
    } catch (_) {}
  };
  themeBtn?.addEventListener('click', () => {
    try {
      const { toggleTheme } = require('./ui');
      const next = toggleTheme();
      syncThemeIcon();
      showToast(next === 'light' ? '已切换亮色主题' : '已切换暗色主题', 1500);
    } catch (err) { showToast('主题切换失败: ' + (err.message || err), 2500); }
  });
  syncThemeIcon();

  const minimizeBtn = document.getElementById('tokfree-btn-minimize');
  const initBtn = document.getElementById('tokfree-btn-init');
  const clearBtn = document.getElementById('tokfree-btn-clear');

  minimizeBtn?.addEventListener('click', hideOverlay);
  initBtn?.addEventListener('click', handleInitProject);

  // 一键登录：登录页显示，点击弹出该平台账号选择框，选中后调用 quickLogin
  const quickLoginBtn = document.getElementById('tokfree-btn-quick-login');
  quickLoginBtn?.addEventListener('click', async () => {
    try {
      const provider = getProviderByUrl(window.location.href);
      const pid = provider && provider.id ? provider.id : '';
      const [acctRes, usageRes] = await Promise.all([
        window.electronAPI.listAccounts(pid || undefined),
        window.electronAPI.listAccountUsage ? window.electronAPI.listAccountUsage() : Promise.resolve({ success: true, usage: {} }),
      ]);
      const accounts = (acctRes && acctRes.success && acctRes.accounts) || [];
      const usage = (usageRes && usageRes.success && usageRes.usage) || {};
      if (accounts.length === 0) {
        showToast('账号池中没有该平台的可用账号，请先在「账号池」面板添加', 4000);
        return;
      }
      let currentProfileId = '';
      try {
        const pidRes = await window.electronAPI.getCurrentProfileId();
        if (pidRes && pidRes.success && pidRes.profileId) currentProfileId = pidRes.profileId;
      } catch (e) { /* 取不到则退化为空串，保持原行为 */ }
      const chosenId = await showAccountSelectDialog({
        reason: '请选择一个账号一键登录',
        accounts,
        usage,
        currentProfileId,
      });
      if (!chosenId) return;
      // 传 currentProfileId 作兜底：主进程若从 event.sender 反查不到上下文（壳层转发/
      // 首次加载 webview 未注册等边界），可用它精确定位窗口。
      const r = await window.electronAPI.quickLogin(chosenId, currentProfileId);
      showToast(r && r.success ? '已用所选账号登录中…' : ('登录失败: ' + ((r && r.error) || '未知')), 3000);
    } catch (err) {
      showToast('一键登录失败: ' + (err.message || err), 3000);
    }
  });

  // 首次使用提示浮窗：初始化按钮（与右侧初始化项目逻辑一致）
  const firstInitBtn = document.getElementById('tokfree-btn-first-init');
  firstInitBtn?.addEventListener('click', handleInitProject);

  // 首次使用提示浮窗：关闭按钮
  const firstCloseBtn = document.getElementById('tokfree-btn-first-close');
  firstCloseBtn?.addEventListener('click', hideFirstTimeDialog);
  clearBtn?.addEventListener('click', () => {
    commandHistory.length = 0;
    renderHistory();
  });

  // 手动解析按钮
  const manualParseBtn = document.getElementById('tokfree-btn-manual-parse');
  manualParseBtn?.addEventListener('click', handleManualParse);

  // 补充说明发送：AI 忙时排队（随下一个回执一起发），空闲时直接发
  const userSendBtn = document.getElementById('tokfree-user-send');
  const userInput = document.getElementById('tokfree-user-input');
  const userHint = document.getElementById('tokfree-user-queue-hint');
  const doSendUserMsg = () => {
    if (!userInput) return;
    const text = userInput.value.trim();
    if (!text) return;
    try {
      const { sendUserMessage } = require('../dom/chat-input');
      const r = sendUserMessage(text);
      if (r && r.queued) {
        if (userHint) userHint.textContent = '已排队 ' + r.count + ' 条（等回执一起发）';
        showToast('AI 忙，已排队（' + r.count + ' 条）', 2000);
      } else {
        if (userHint) userHint.textContent = '已发送';
        showToast('已发送', 1500);
      }
      userInput.value = '';
    } catch (err) {
      showToast('发送失败: ' + (err.message || err), 3000);
    }
  };
  userSendBtn?.addEventListener('click', doSendUserMsg);
  userInput?.addEventListener('keydown', (e) => {
    // ⚠️ 关键：中文/日文输入法用回车「确认候选词」，此时 isComposing=true，
    // 绝不能当作发送，否则打字打一半就被截断发出去。
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSendUserMsg(); }
  });

  // 窗口管理按钮：打开浮动管理面板
  const windowManagerBtn = document.getElementById('tokfree-btn-window-manager');
  windowManagerBtn?.addEventListener('click', () => {
    openWindowManager();
  });

  // 看门狗：暂停/恢复
  const wdToggleBtn = document.getElementById('tokfree-wd-toggle');
  wdToggleBtn?.addEventListener('click', async () => {
    try {
      const res = await window.electronAPI.watchdogStatus();
      const cfg = res && res.success ? res.status.config : null;
      const nextPaused = cfg ? !cfg.paused : true;
      await window.electronAPI.watchdogSetPaused(nextPaused);
      showToast(nextPaused ? '看门狗已暂停' : '看门狗已恢复', 2000);
      renderWatchdogPanel();
    } catch (e) {
      showToast('操作失败: ' + (e.message || e), 3000);
    }
  });

  // 看门狗：立即唤醒
  const wdWakeBtn = document.getElementById('tokfree-wd-wake');
  wdWakeBtn?.addEventListener('click', async () => {
    try {
      const res = await window.electronAPI.watchdogWake();
      showToast(res && res.success ? '已发送唤醒' : ('唤醒失败: ' + ((res && res.error) || '未知')), 2500);
      renderWatchdogPanel();
    } catch (e) {
      showToast('唤醒失败: ' + (e.message || e), 3000);
    }
  });

  // 看门狗：刷新状态
  const wdRefreshBtn = document.getElementById('tokfree-wd-refresh');
  wdRefreshBtn?.addEventListener('click', renderWatchdogPanel);

  // MCP 按钮：打开 MCP 管理面板
  const mcpBtn = document.getElementById('tokfree-btn-mcp');
  mcpBtn?.addEventListener('click', openMcpManager);

  // 知识库按钮：打开知识库面板
  const knowBtn = document.getElementById('tokfree-btn-knowledge');
  knowBtn?.addEventListener('click', openKnowledgeManager);

  // 知识库面板：关闭
  const knowCloseBtn = document.getElementById('tokfree-know-close');
  knowCloseBtn?.addEventListener('click', closeKnowledgeManager);

  // 知识库面板：刷新
  const knowRefreshBtn = document.getElementById('tokfree-know-refresh');
  knowRefreshBtn?.addEventListener('click', renderKnowledgePanel);

  // 知识库面板：新建技能（未选中技能时提交新建；已选中时先清空进入新建态）
  const knowCreateBtn = document.getElementById('tokfree-know-create');
  knowCreateBtn?.addEventListener('click', async () => {
    const nameInput = document.getElementById('tokfree-know-name');
    const content = document.getElementById('tokfree-know-content');
    if (knowSelected) {
      // 进入新建态：清空选中与输入框
      knowSelected = null;
      updateKnowButtons();
      if (nameInput) { nameInput.classList.remove('tokfree-hidden'); nameInput.value = ''; nameInput.focus(); }
      if (content) { content.value = ''; content.focus(); }
      showToast('请输入技能名与正文，再次点击「新建技能」提交', 2500);
      return;
    }
    // 提交新建
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) { showToast('请输入技能名', 3000); if (nameInput) nameInput.focus(); return; }
    try {
      const r = await window.electronAPI.knowledgeCreate(name, content ? content.value : '', {});
      if (r && r.success) {
        showToast('技能已创建', 1800);
        await renderKnowledgePanel();
        await selectKnowledgeSkill(name);
      } else {
        showToast((r && r.error) || '创建失败', 3000);
      }
    } catch (err) {
      showToast('创建失败: ' + (err.message || err), 3000);
    }
  });

  // 知识库面板：保存技能（修改选中技能正文）
  const knowSaveBtn = document.getElementById('tokfree-know-save');
  knowSaveBtn?.addEventListener('click', async () => {
    if (!knowSelected) { showToast('请先选择一个技能', 2500); return; }
    const content = document.getElementById('tokfree-know-content');
    try {
      const r = await window.electronAPI.knowledgeSave(knowSelected, content ? content.value : '');
      if (r && r.success) showToast('技能已保存', 1800);
      else showToast((r && r.error) || '保存失败', 3000);
    } catch (err) {
      showToast('保存失败: ' + (err.message || err), 3000);
    }
  });

  // 知识库面板：删除技能
  const knowDelBtn = document.getElementById('tokfree-know-delete');
  knowDelBtn?.addEventListener('click', async () => {
    if (!knowSelected) return;
    const ok = await showConfirmDialog('确定删除技能「' + knowSelected + '」？此操作不可恢复。', { okText: '删除', showCancel: true, cancelText: '取消' });
    if (!ok) return;
    try {
      const r = await window.electronAPI.knowledgeDelete(knowSelected);
      if (r && r.success) {
        showToast('已删除', 1800);
        knowSelected = null;
        updateKnowButtons();
        await renderKnowledgePanel();
      } else {
        showToast((r && r.error) || '删除失败', 3000);
      }
    } catch (err) {
      showToast('删除失败: ' + (err.message || err), 3000);
    }
  });

  // 知识库面板：启用/禁用当前技能
  const knowToggleBtn = document.getElementById('tokfree-know-toggle-enabled');
  knowToggleBtn?.addEventListener('click', async () => {
    if (!knowSelected) return;
    const on = knowEnabled.indexOf(knowSelected) !== -1;
    try {
      const r = on
        ? await window.electronAPI.knowledgeDisable(knowSelected)
        : await window.electronAPI.knowledgeEnable(knowSelected);
      if (r && r.success) showToast(on ? '已在本项目禁用' : '已在本项目启用', 1800);
      else showToast((r && r.error) || '操作失败', 3000);
      await renderKnowledgePanel();
      updateKnowButtons();
    } catch (err) {
      showToast('操作失败: ' + (err.message || err), 3000);
    }
  });

  // 知识库面板：保存全局偏好
  const prefSaveBtn = document.getElementById('tokfree-pref-save');
  prefSaveBtn?.addEventListener('click', async () => {
    const pref = document.getElementById('tokfree-know-pref');
    try {
      const r = await window.electronAPI.preferenceSave(pref ? pref.value : '');
      if (r && r.success) showToast('全局偏好已保存', 1800);
      else showToast((r && r.error) || '保存失败', 3000);
    } catch (err) {
      showToast('保存失败: ' + (err.message || err), 3000);
    }
  });

  // MCP 面板：关闭
  const mcpCloseBtn = document.getElementById('tokfree-mcp-close');
  mcpCloseBtn?.addEventListener('click', closeMcpManager);

  // MCP 面板：刷新
  const mcpRefreshBtn = document.getElementById('tokfree-mcp-refresh');
  mcpRefreshBtn?.addEventListener('click', renderMcpList);

  // MCP 面板：保存配置
  const mcpSaveBtn = document.getElementById('tokfree-mcp-save');
  mcpSaveBtn?.addEventListener('click', async () => {
    const jsonInput = document.getElementById('tokfree-mcp-json');
    if (!jsonInput || !jsonInput.value.trim()) {
      showToast('请输入配置', 3000);
      return;
    }
    try {
      const parsed = JSON.parse(jsonInput.value);
      if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
        showToast('配置格式错误，需要 mcpServers 对象', 3000);
        return;
      }

      // 校验每个 server 定义是否完整合法（发现错误立即中止，不删旧配置、不覆盖编辑框）
      for (const [name, def] of Object.entries(parsed.mcpServers)) {
        if (!def || typeof def !== 'object' || Array.isArray(def)) {
          showToast('配置错误：server "' + name + '" 的定义必须是对象', 4000);
          return;
        }
        const hasUrl = def.url !== undefined;
        const hasCommand = def.command !== undefined;
        if (hasUrl) {
          if (typeof def.url !== 'string' || !def.url.trim()) {
            showToast('配置错误：server "' + name + '" 的 url 必须是非空字符串', 4000);
            return;
          }
          if (hasCommand) {
            showToast('配置错误：server "' + name + '" 不能同时指定 url 和 command', 4000);
            return;
          }
        } else if (hasCommand) {
          if (typeof def.command !== 'string' || !def.command.trim()) {
            showToast('配置错误：server "' + name + '" 的 command 必须是非空字符串', 4000);
            return;
          }
        } else {
          showToast('配置错误：server "' + name + '" 缺少 command 或 url', 4000);
          return;
        }
        if (def.args !== undefined && !Array.isArray(def.args)) {
          showToast('配置错误：server "' + name + '" 的 args 必须是数组', 4000);
          return;
        }
        if (def.env !== undefined && (typeof def.env !== 'object' || def.env === null || Array.isArray(def.env))) {
          showToast('配置错误：server "' + name + '" 的 env 必须是对象', 4000);
          return;
        }
        if (def.headers !== undefined && (typeof def.headers !== 'object' || def.headers === null || Array.isArray(def.headers))) {
          showToast('配置错误：server "' + name + '" 的 headers 必须是对象', 4000);
          return;
        }
      }

      // 先删除 JSON 里不存在的旧 server
      const oldRes = await window.electronAPI.listMcpServers();
      const oldServers = (oldRes && oldRes.success && oldRes.servers) || [];
      const newNames = new Set(Object.keys(parsed.mcpServers));
      for (const old of oldServers) {
        if (!newNames.has(old.name)) {
          await window.electronAPI.removeMcpServer(old.name);
        }
      }

      // 逐个 upsert 新配置
      for (const [name, def] of Object.entries(parsed.mcpServers)) {
        const server = {
          name,
          type: def && def.url ? 'http' : 'stdio',
          command: def && def.command,
          args: def && def.args || [],
          url: def && def.url,
          headers: def && def.headers,
          env: def && def.env,
        };
        await window.electronAPI.upsertMcpServer(server);
      }
      showToast('配置已保存', 2200);
      await renderMcpList();
      await loadMcpConfigToJson();
      // 询问用户是否将 MCP 更新通知发给 AI（不自动发送）
      try {
        const confirmed = await showConfirmDialog(
          'MCP 配置已保存。\n\n是否告诉 AI 配置已更新？\n（请确保 AI 当前没有正在进行其他操作）',
          { okText: '发送', showCancel: true, cancelText: '取消' }
        );
        if (!confirmed) return;

        const res = await window.electronAPI.getMcpTools();
        const tools = res && res.success ? res.tools : [];
        const serverNames = Array.from(new Set(tools.map(t => t.server)));
        let msg = '【MCP 配置已更新】\n\n';
        if (serverNames.length === 0) {
          msg += '当前没有已连接的 MCP server。';
        } else {
          msg += '可用的 MCP server：' + serverNames.join('、') + '。\n';
          msg += '需要时用 mcpListServers() 查看概览，或用 mcpGetTools(serverName) 查看具体工具。';
        }
        await sendToChat(msg, 'MCP信息', 300);
      } catch (err) {
        console.error('[TokFree] 发送 MCP 信息失败:', err);
      }
    } catch (err) {
      showToast('保存失败: ' + (err.message || err), 3000);
    }
  });



  // 浮动面板：新建窗口（不指定平台，让窗口显示平台选择页）
  const wmNewWindowBtn = document.getElementById('tokfree-wm-new-window');
  wmNewWindowBtn?.addEventListener('click', async () => {
    try {
      await window.electronAPI.createProfileWindow();
      showToast('已打开平台选择', 2200);
      await renderWindowList();
    } catch (err) {
      showToast('创建新窗口失败: ' + (err.message || err), 3000);
    }
  });

  // 浮动面板：关闭
  const wmCloseBtn = document.getElementById('tokfree-wm-close');
  wmCloseBtn?.addEventListener('click', closeWindowManager);

  // 目标进度面板：入口 + 内部按钮绑定
  try { goalPanel.bindGoalPanel(); } catch (_) {}
  const goalBtn = document.getElementById('tokfree-btn-goal');
  goalBtn?.addEventListener('click', function () { goalPanel.openGoalManager(); });

  // 浮动面板：刷新列表
  const wmRefreshBtn = document.getElementById('tokfree-wm-refresh');
  wmRefreshBtn?.addEventListener('click', () => { renderWindowList(); renderStatsPanel(); renderUsagePanel(); });

  // 运行统计：查看/收起日志
  const statsLogBtn = document.getElementById('tokfree-stats-log-btn');
  statsLogBtn?.addEventListener('click', async () => {
    const logEl = document.getElementById('tokfree-stats-log');
    if (!logEl) return;
    const hidden = logEl.classList.contains('tokfree-hidden');
    if (hidden) {
      logEl.classList.remove('tokfree-hidden');
      statsLogBtn.textContent = '收起日志';
      await renderStatsLog();
    } else {
      logEl.classList.add('tokfree-hidden');
      statsLogBtn.textContent = '查看日志';
    }
  });

  // 用量统计：刷新按钮
  const usageRefreshBtn = document.getElementById('tokfree-usage-refresh');
  usageRefreshBtn?.addEventListener('click', () => { renderUsagePanel(); });

  // 窗口设置面板（账号/代理/指纹）
  bindProfileConfigEvents();

  // 生成项目说明文档按钮
  const genDocBtn = document.getElementById('tokfree-btn-gen-doc');
  genDocBtn?.addEventListener('click', handleGenerateDoc);

  // 沉浸式交流按钮
  const immersiveBtn = document.getElementById('tokfree-btn-immersive');
  immersiveBtn?.addEventListener('click', async () => {
    const message = '现在你的任何疑问,或没有疑问的选择都需要和我确认 , 确认的方式是 你问一个问题我回答一个问题,然后你再问下一个问题, 最好给我选项, 也要给我个其他的选项, 谢谢 爱你哦';
    try {
      const ok = await sendToChat(message, '沉浸式交流', 300);
      if (!ok) {
        showToast('发送失败（未找到输入框或消息未发出），请确保已打开聊天界面', 3000);
      } else {
        showToast('已发送沉浸式交流提示', 2200);
      }
    } catch (e) {
      showToast('发送失败: ' + ((e && e.message) || e), 3000);
    }
  });

  // 刷新会话列表按钮
  const refreshSessionsBtn = document.getElementById('tokfree-btn-refresh-sessions');
  refreshSessionsBtn?.addEventListener('click', renderSessions);

  // 保存延迟设置按钮
  // ========== 磁盘清理 ==========
  const fmtMB = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB';
  const refreshDiskUsage = async () => {
    const el = document.getElementById('tokfree-disk-usage');
    if (!el) return;
    try {
      const r = await window.electronAPI.cleanupUsage();
      if (r && r.success && r.usage) {
        const u = r.usage;
        el.textContent = '总计 ' + fmtMB(u.total) + '（缓存 ' + fmtMB(u.partitions) + '、截图 ' + fmtMB(u.screenshots) + '、日志 ' + fmtMB(u.logs) + '）';
      } else {
        el.textContent = '占用查询失败';
      }
    } catch (err) { el.textContent = '占用查询失败'; }
  };
  document.getElementById('tokfree-btn-cleanup-cache')?.addEventListener('click', async () => {
    try {
      const r = await window.electronAPI.cleanupCache();
      if (r && r.success) {
        showToast('缓存已清理，释放 ' + fmtMB(r.result.freedBytes || 0), 3000);
        refreshDiskUsage();
      } else {
        showToast('清理失败: ' + ((r && r.error) || '未知'), 3000);
      }
    } catch (err) { showToast('清理失败: ' + (err.message || err), 3000); }
  });
  document.getElementById('tokfree-btn-cleanup-all')?.addEventListener('click', async () => {
    try {
      const r = await window.electronAPI.cleanupAll();
      if (r && r.success) {
        const res = r.result || {};
        showToast('已清理：孤儿 ' + (res.partitions || 0) + ' 个、截图 ' + (res.screenshots || 0) + ' 张，释放 ' + fmtMB(res.freedBytes || 0), 4000);
        refreshDiskUsage();
      } else {
        showToast('清理失败: ' + ((r && r.error) || '未知'), 3000);
      }
    } catch (err) { showToast('清理失败: ' + (err.message || err), 3000); }
  });
  // 打开面板时刷新占用（延迟，等 DOM 就绪）
  setTimeout(refreshDiskUsage, 1500);

  const saveDelayBtn = document.getElementById('tokfree-btn-save-delay');
  const delayMinInput = document.getElementById('tokfree-delay-min');
  const delayMaxInput = document.getElementById('tokfree-delay-max');
  saveDelayBtn?.addEventListener('click', () => {
    const min = parseInt(delayMinInput?.value, 10);
    const max = parseInt(delayMaxInput?.value, 10);
    if (Number.isNaN(min) || min < 0) { showToast('最小延迟必须是非负整数', 3000); return; }
    if (Number.isNaN(max) || max < min) { showToast('最大延迟不能小于最小延迟', 3000); return; }
    if (max > 10000) { showToast('最大延迟不能超过 10000ms', 3000); return; }
    state.sendDelayMin = min;
    state.sendDelayMax = max;
    // 写入全局设置（跨标签共享），并保留 localStorage 作为降级缓存
    try {
      localStorage.setItem('tokfree-send-delay-min', String(min));
      localStorage.setItem('tokfree-send-delay-max', String(max));
    } catch (e) {}
    if (window.electronAPI && window.electronAPI.setSendDelay) {
      window.electronAPI.setSendDelay(min, max).catch(function () {});
    }
    showToast('延迟设置已保存（全局生效）：' + min + ' - ' + max + ' ms', 3000);
  });

  // 悬浮球与悬浮窗已彻底禁用：点击不再切换面板

  // 键盘快捷键
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+C 切换覆盖层：已禁用（悬浮窗不再显示）
    // Esc 隐藏覆盖层和窗口管理面板
    if (e.key === 'Escape') {
      hideOverlay();
      closeWindowManager();
      closeMcpManager();
      try { goalPanel.closeGoalManager(); } catch (_) {}
      hideFirstTimeDialog();
    }
  });

  // 压缩上下文按钮
  const compactBtn = document.getElementById('tokfree-btn-compact');
  compactBtn?.addEventListener('click', runCompaction);

  // 保存自动压缩设置
  const autoCompactSaveBtn = document.getElementById('tokfree-auto-compact-save');
  autoCompactSaveBtn?.addEventListener('click', saveAutoCompactConfig);

  // 加载自动压缩配置
  loadAutoCompactConfig();

  // Plan/Act 模式 + 操作确认
  bindPolicyEvents();

  // 启动对话 token 显示 + 自动压缩检查
  startTokenCounter();

  // 检查是否为「压缩后自动初始化」场景
  try { checkPendingInit(); } catch (e) { /* ignore */ }

  // 任务清单面板（todo_write 可视化）：首渲 + 定时轮询
  try { startTodoPanel(); } catch (e) { /* ignore */ }
}

module.exports = bindEvents;