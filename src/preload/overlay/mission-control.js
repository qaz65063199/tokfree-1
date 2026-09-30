/**
 * 任务中心（Mission Control）—— 可视化所有 Agent 活动
 *
 * 数据源：
 *  - listWindowsStatus()：各窗口 AI 状态（空闲/执行中/中断/限流/禁言）+ 当前任务
 *  - getEventLog(30)：最近事件日志（催促/拦截/派发/完成）
 *
 * 只读面板，不改变任何状态。
 */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

async function renderMissionControl() {
  const eventsEl = document.getElementById('tokfree-stats-events');
  const ovEl = document.getElementById('tokfree-wm-overview');

  let wins = [];
  try {
    const r = await window.electronAPI.listWindowsStatus();
    if (r && r.success) wins = r.windows || [];
  } catch (_) {}

  // 概览
  let busy = 0, idle = 0, warn = 0;
  wins.forEach(function (w) {
    if (w.state === 'busy') busy++;
    else if (w.state === 'warn' || w.state === 'banned') warn++;
    else idle++;
  });
  if (ovEl) {
    ovEl.innerHTML =
      '<div class="tokfree-mc-card"><div class="tokfree-mc-num">' + wins.length + '</div><div class="tokfree-mc-lbl">Agent 窗口</div></div>' +
      '<div class="tokfree-mc-card"><div class="tokfree-mc-num" style="color:#ffc107;">' + busy + '</div><div class="tokfree-mc-lbl">执行中</div></div>' +
      '<div class="tokfree-mc-card"><div class="tokfree-mc-num" style="color:#7fd6a3;">' + idle + '</div><div class="tokfree-mc-lbl">空闲</div></div>' +
      '<div class="tokfree-mc-card"><div class="tokfree-mc-num" style="color:#ff6b7a;">' + warn + '</div><div class="tokfree-mc-lbl">需注意</div></div>';
  }

  // 最近活动
  if (eventsEl) {
    try {
      const er = await window.electronAPI.getEventLog(30);
      const events = (er && er.success && er.events) || [];
      if (!events.length) {
        eventsEl.innerHTML = '<div class="tokfree-session-empty">暂无活动</div>';
      } else {
        eventsEl.innerHTML = events.map(function (ev) {
          const ts = ev.ts || ev.time || Date.now();
          const d = new Date(ts);
          const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
          return '<div class="tokfree-mc-event">' +
            '<span class="t">' + hh + '</span>' +
            '<span class="k">' + esc(ev.type || '?') + '</span>' +
            '<span class="d">' + esc(ev.detail || ev.sub || '') + '</span>' +
          '</div>';
        }).join('');
      }
    } catch (_) {
      eventsEl.innerHTML = '<div class="tokfree-session-empty">暂无活动</div>';
    }
  }
}

// 独立任务中心面板已并入「窗口管理」：状态卡片渲染进 #tokfree-wm-overview，
// 最近活动渲染进「运行统计」的 #tokfree-stats-events。
// 打开窗口管理时由 events.js 调用 renderMissionControl 刷新。
function openMissionControl() {
  renderMissionControl();
}

function bindMissionControl() {
  // 独立入口按钮已移除，保留空实现以兼容 index.js 的调用。
}

module.exports = { bindMissionControl, openMissionControl, renderMissionControl };
