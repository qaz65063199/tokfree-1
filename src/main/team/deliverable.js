/**
 * 成果交付（Deliverable）—— 自驱循环的"汇报"机制
 *
 * 解决的问题：无人干预循环跑完/跑一半，用户需要知道"进展如何、成果是什么"。
 *
 * 提供：
 *   1. 目标完成报告（goal report）：达标时生成完整成果摘要
 *   2. 进展汇报（progress report）：中途定期汇报
 *   3. 关键节点通知：达标/熔断/停滞时通知用户
 *
 * 纯生成模块：不直接发通知（通知由上层/UI 决定），只产出"报告文本 + 数据"。
 */
const selfLoop = require('./self-loop');

const NL = String.fromCharCode(10);

/**
 * 生成目标完成报告（达标时）
 * @param {string} goalId
 * @returns {string} Markdown 报告
 */
function buildGoalReport(goalId) {
  try {
    const g = selfLoop.getGoal(goalId);
    if (!g) return '';
    const lines = [];
    lines.push('# 🎯 目标达成报告');
    lines.push('');
    lines.push('## 目标');
    lines.push(g.title);
    lines.push('');
    lines.push('## 状态');
    lines.push('- 结果：**' + statusText(g.status) + '**');
    lines.push('- 轮次：' + g.round + ' 轮');
    lines.push('- 最高分：' + Math.round((g.bestScore || 0) * 100) + '%');
    lines.push('- 用时：' + formatDuration(g.updatedAt - g.createdAt));
    lines.push('');
    lines.push('## 达标标准');
    g.successCriteria.forEach(function (c, i) {
      const last = g.history[g.history.length - 1];
      const ok = last && last.detail && last.detail.indexOf('✓ ' + c) !== -1;
      lines.push('- ' + (ok ? '✅' : '⬜') + ' ' + c);
    });
    lines.push('');
    lines.push('## 执行历程');
    g.history.forEach(function (h) {
      lines.push('- 第 ' + h.round + ' 轮：' + Math.round((h.score || 0) * 100) + '% — ' +
        (h.note || (h.actions && h.actions.length ? h.actions.join('、') : h.detail || '')));
    });
    lines.push('');
    lines.push('## 沉淀的技能');
    lines.push('（本次循环中生成/优化的技能见技能库，可用 skill_list 查看）');
    return lines.join(NL);
  } catch (e) {
    return '';
  }
}

/**
 * 生成进展汇报（中途）
 * @param {string} goalId
 * @returns {string}
 */
function buildProgressReport(goalId) {
  try {
    const g = selfLoop.getGoal(goalId);
    if (!g) return '';
    const last = g.history[g.history.length - 1];
    const next = selfLoop.decideNextAction(goalId);
    const lines = [];
    lines.push('📊 目标进展：' + g.title);
    lines.push('第 ' + g.round + ' 轮 | 最高分 ' + Math.round((g.bestScore || 0) * 100) + '% | 状态 ' + statusText(g.status));
    if (last) lines.push('最近一轮：' + Math.round((last.score || 0) * 100) + '% — ' + (last.note || last.detail || ''));
    lines.push('下一步：' + actionText(next.action));
    return lines.join(NL);
  } catch (e) {
    return '';
  }
}

/**
 * 生成"全部运行中目标"的汇总（供面板展示）
 */
function buildAllGoalsSummary() {
  try {
    const goals = selfLoop.listGoals();
    if (goals.length === 0) return '（暂无目标）';
    const lines = [];
    goals.forEach(function (g) {
      lines.push('[' + statusText(g.status) + '] ' + g.title + ' — 第' + g.round + '轮 / 最高' +
        Math.round((g.bestScore || 0) * 100) + '%');
    });
    return lines.join(NL);
  } catch (e) {
    return '';
  }
}

/**
 * 判断是否需要通知用户（关键节点）
 * @returns {{ notify: boolean, level: string, message: string }}
 */
function shouldNotify(goalId, event) {
  try {
    const g = selfLoop.getGoal(goalId);
    if (!g) return { notify: false, level: 'none', message: '' };
    if (event === 'achieved') {
      return { notify: true, level: 'success', message: '🎉 目标达成：' + g.title };
    }
    if (event === 'exhausted') {
      return { notify: true, level: 'warn', message: '⚠️ 目标达到上限未完成：' + g.title };
    }
    if (event === 'circuit-break') {
      return { notify: true, level: 'warn', message: '⚡ 自驱循环熔断（异常/停滞）：' + g.title };
    }
    return { notify: false, level: 'none', message: '' };
  } catch (e) {
    return { notify: false, level: 'none', message: '' };
  }
}

function statusText(s) {
  return { running: '进行中', achieved: '已达成', exhausted: '已达上限', aborted: '已中止' }[s] || s;
}
function actionText(a) {
  return { execute: '执行/推进', retrospect: '复盘', forge: '生成技能', optimize: '优化', done: '已完成' }[a] || a;
}
function formatDuration(ms) {
  if (!ms || ms < 0) return '0秒';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + '小时' + m + '分';
  if (m > 0) return m + '分';
  return s + '秒';
}

module.exports = {
  buildGoalReport,
  buildProgressReport,
  buildAllGoalsSummary,
  shouldNotify,
};
