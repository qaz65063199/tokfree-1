/**
 * 目标进度面板（Goal Progress）—— 可视化自驱循环目标的达标情况
 *
 * 数据源：window.electronAPI.goalStatusList() → 主进程 IPC 'goal-status-list'
 *        → src/main/team/self-loop.js 的 listGoals()（读 goals.json）。
 *
 * 展示：每个 goal 的标题、状态、当前轮次/最大轮次、各达标标准 ✅/❌、bestScore。
 * 只读面板，不改变任何状态。
 */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// 状态 → 中文标签 + 颜色
const STATUS_MAP = {
  running: { text: '进行中', color: '#ffc107' },
  achieved: { text: '已达标', color: '#7fd6a3' },
  perfect: { text: '已完美', color: '#7fd6a3' },
  exhausted: { text: '轮次耗尽', color: '#8a90b8' },
  aborted: { text: '已中止', color: '#ff6b7a' },
};

/**
 * 从 goal 对象提取「各达标标准 + 通过状态」。
 * 优先用最新一轮 history 的 detail（格式：'✓ c1；✗ c2'）；
 * 无 history 时退化为未评估（⬜）。
 * @returns {Array<{text:string, ok:boolean|null}>}
 */
function extractCriteria(goal) {
  const crit = Array.isArray(goal.successCriteria) ? goal.successCriteria : [];
  const history = Array.isArray(goal.history) ? goal.history : [];
  const last = history.length ? history[history.length - 1] : null;
  if (last && typeof last.detail === 'string' && last.detail.indexOf('达标：') !== -1) {
    const after = last.detail.split('达标：')[1] || '';
    const parts = after.split('；').map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length) {
      return parts.map(function (p) {
        const ok = p.charAt(0) === '\u2713';
        return { text: p.replace(/^[\u2713\u2717]\s*/, ''), ok: ok };
      });
    }
  }
  return crit.map(function (c) { return { text: c, ok: null }; });
}

async function renderGoalPanel() {
  const list = document.getElementById('tokfree-goal-list');
  if (!list) return;
  try {
    if (!window.electronAPI || !window.electronAPI.goalStatusList) {
      list.innerHTML = '<div class="tokfree-session-empty">暂不支持</div>';
      return;
    }
    const res = await window.electronAPI.goalStatusList();
    const goals = (res && res.success && res.goals) || [];
    if (!goals.length) {
      list.innerHTML = '<div class="tokfree-session-empty">暂无目标</div>';
      return;
    }
    list.innerHTML = goals.map(function (g) {
      const st = STATUS_MAP[g.status] || { text: g.status || '?', color: '#8a90b8' };
      const round = typeof g.round === 'number' ? g.round : 0;
      const maxRounds = typeof g.maxRounds === 'number' ? g.maxRounds : '-';
      const score = typeof g.bestScore === 'number' ? Math.round(g.bestScore * 100) + '%' : '-';
      const crits = extractCriteria(g);
      const critHtml = crits.length
        ? crits.map(function (c) {
            const icon = c.ok === true ? '✅' : (c.ok === false ? '❌' : '⬜');
            return '<div class="tokfree-goal-crit">' + icon + ' ' + esc(c.text) + '</div>';
          }).join('')
        : '<div class="tokfree-goal-crit tokfree-goal-crit-empty">（无显式达标标准）</div>';
      return '<div class="tokfree-goal-item">' +
        '<div class="tokfree-goal-head">' +
          '<span class="tokfree-goal-title">' + esc(g.title) + '</span>' +
          '<span class="tokfree-goal-status" style="color:' + st.color + ';">' + esc(st.text) + '</span>' +
        '</div>' +
        '<div class="tokfree-goal-meta">轮次 ' + round + '/' + maxRounds + ' · 最佳 ' + score + '</div>' +
        '<div class="tokfree-goal-crits">' + critHtml + '</div>' +
      '</div>';
    }).join('');
  } catch (err) {
    list.innerHTML = '<div class="tokfree-session-empty">加载失败</div>';
  }
}

function openGoalManager() {
  const panel = document.getElementById('tokfree-goal-manager');
  if (panel) {
    panel.classList.remove('tokfree-hidden');
    renderGoalPanel();
  }
}

function closeGoalManager() {
  const panel = document.getElementById('tokfree-goal-manager');
  if (panel) panel.classList.add('tokfree-hidden');
}

/** 绑定面板内的刷新/关闭按钮（幂等，避免重复绑定） */
function bindGoalPanel() {
  if (bindGoalPanel._bound) return;
  bindGoalPanel._bound = true;
  const refreshBtn = document.getElementById('tokfree-goal-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', renderGoalPanel);
  const closeBtn = document.getElementById('tokfree-goal-close');
  if (closeBtn) closeBtn.addEventListener('click', closeGoalManager);
}

module.exports = { renderGoalPanel, openGoalManager, closeGoalManager, bindGoalPanel };
