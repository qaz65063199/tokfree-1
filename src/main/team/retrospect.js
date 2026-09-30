'use strict';
/**
 * 复盘引擎（RetrospectEngine）—— Agent 自工程化 Level 1 核心
 *
 * 消费执行轨迹（src/main/team/trace.js），产出结构化复盘报告：
 *   - 执行摘要（步骤数、成功/失败、耗时、outcome）
 *   - 可优化点（失败模式 / 耗时热点 / 重复重试）
 *   - 每个优化点的具体方案（Prompt 修改 / 步骤调整 / 错误处理补充）
 *   - 给「复盘 Agent」的 Prompt 模板构造函数
 *
 * 设计原则：
 *   - 纯 Node 模块，只依赖 trace.js（其内部经 agent-runtime paths 定位存储）
 *   - 容错：任何异常都静默降级，绝不抛出、绝不改变现有行为
 */
const trace = require('./trace');

const HOTSPOT_RATIO = 2;      // 单步耗时 > 平均 * N 视为热点
const HOTSPOT_MIN_MS = 1000;  // 热点最小耗时阈值（毫秒）
const RETRY_MIN = 2;          // 相同签名出现 >= N 次视为重复/重试
const MAX_PROMPT_STEPS = 60;  // Prompt 中最多列出的步骤数

function num(v) {
  return (typeof v === 'number' && isFinite(v)) ? v : 0;
}

function truncate(s, n) {
  s = s == null ? '' : String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 把任意值安全转成字符串（用于签名） */
function safeStr(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

/** 归一化错误文本（压缩空白、限量） */
function normErr(e) {
  if (!e) return '';
  return String(e).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** 推断 outcome */
function inferOutcome(successCount, failCount, total) {
  if (!total) return 'empty';
  if (failCount === 0) return 'success';
  if (failCount === total) return 'failed';
  return 'partial';
}

/** 墙钟耗时（startedAt → endedAt） */
function wallDurationMs(t) {
  try {
    if (!t || !t.startedAt || !t.endedAt) return 0;
    var d = Date.parse(t.endedAt) - Date.parse(t.startedAt);
    return isFinite(d) && d >= 0 ? d : 0;
  } catch (e) { return 0; }
}

/** 接受 trace 对象或 taskId，解析出 trace 对象（失败返回 null） */
function resolveTrace(input) {
  try {
    if (!input) return null;
    if (typeof input === 'string') return trace.getTrace(input);
    if (typeof input === 'object') {
      if (Array.isArray(input.steps)) return input;
      if (input.taskId) return trace.getTrace(input.taskId);
    }
  } catch (e) {}
  return null;
}

function emptyAnalysis(t) {
  return {
    ok: false,
    summary: {
      taskId: (t && t.taskId) ? t.taskId : '',
      profileId: (t && t.profileId) ? t.profileId : '',
      goal: (t && t.goal) ? t.goal : '',
      outcome: (t && t.outcome) || 'empty',
      stepCount: 0,
      successCount: 0,
      failCount: 0,
      totalDurationMs: 0,
      avgStepMs: 0,
      wallDurationMs: wallDurationMs(t),
      startedAt: (t && t.startedAt) ? t.startedAt : null,
      endedAt: (t && t.endedAt) ? t.endedAt : null,
    },
    failureModes: [],
    hotspots: [],
    retries: [],
    findings: [],
  };
}

/** 由分析结果构造「可优化点」列表 */
function buildFindings(summary, failureModes, hotspots, retries) {
  var out = [];

  failureModes.forEach(function (m) {
    out.push({
      type: 'failure',
      severity: m.count >= 3 ? 'high' : 'medium',
      title: '失败模式：' + (m.tool || '未知工具'),
      detail: '失败 ' + m.count + ' 次，错误："' + truncate(m.error, 120) + '"，步骤 ' + m.seqs.join(','),
      suggestion: '补充错误处理：调用 ' + (m.tool || '该工具') + ' 前校验前置条件，失败时按 "' +
        truncate(m.error, 40) + '" 分类重试或降级。',
    });
  });

  hotspots.forEach(function (h) {
    if (num(h.durationMs) < HOTSPOT_MIN_MS) return;
    out.push({
      type: 'hotspot',
      severity: 'medium',
      title: '耗时热点：' + (h.tool || '未知工具') + ' (' + h.durationMs + 'ms)',
      detail: '步骤 ' + h.seq + ' 耗时 ' + h.durationMs + 'ms，显著高于平均 ' + summary.avgStepMs + 'ms',
      suggestion: '优化步骤：拆分/合并 ' + (h.tool || '该步骤') + ' 的调用，或缩小其输入规模（如缩小读取范围、减少批量）。',
    });
  });

  retries.forEach(function (r) {
    out.push({
      type: 'retry',
      severity: r.failCount > 0 ? 'high' : 'low',
      title: '重复调用：' + (r.tool || '未知工具') + ' ×' + r.count,
      detail: '相同参数重复 ' + r.count + ' 次（步骤 ' + r.seqs.join(',') + '）' +
        (r.failCount ? '，其中 ' + r.failCount + ' 次失败' : ''),
      suggestion: '合并重复调用：一次性批量执行，或调整 Prompt 让 AI 不重复同一动作。',
    });
  });

  var rank = { high: 0, medium: 1, low: 2 };
  out.sort(function (a, b) { return (rank[a.severity] || 9) - (rank[b.severity] || 9); });
  return out;
}

/**
 * 纯规则分析轨迹（不调 AI）
 * @param {object|string} input trace 对象或 taskId
 * @returns {{ok:boolean, summary:object, failureModes:Array, hotspots:Array, retries:Array, findings:Array}}
 */
function analyzeTrace(input) {
  try {
    var t = resolveTrace(input);
    if (!t || !Array.isArray(t.steps)) return emptyAnalysis(t);

    var steps = t.steps;
    var successCount = 0, failCount = 0, totalDurationMs = 0;
    var failures = [];
    var sigMap = {};
    var durationSteps = [];

    for (var i = 0; i < steps.length; i++) {
      var s = steps[i] || {};
      var ok = s.success !== false;
      if (ok) successCount++; else { failCount++; failures.push(s); }

      var d = num(s.durationMs);
      totalDurationMs += d;
      durationSteps.push({
        seq: s.seq,
        tool: s.tool || '',
        durationMs: d,
        success: ok,
        error: s.error || '',
      });

      var sig = (s.tool || '') + '|' + safeStr(s.args);
      if (!sigMap[sig]) sigMap[sig] = { tool: s.tool || '', count: 0, seqs: [], failCount: 0 };
      sigMap[sig].count++;
      sigMap[sig].seqs.push(s.seq);
      if (!ok) sigMap[sig].failCount++;
    }

    // 耗时热点
    var avg = steps.length ? totalDurationMs / steps.length : 0;
    var threshold = Math.max(HOTSPOT_MIN_MS, avg * HOTSPOT_RATIO);
    var sorted = durationSteps.slice().sort(function (a, b) { return b.durationMs - a.durationMs; });
    var hotspots = [];
    for (var j = 0; j < sorted.length; j++) {
      if (sorted[j].durationMs >= threshold && sorted[j].durationMs > 0) hotspots.push(sorted[j]);
    }
    if (hotspots.length === 0) {
      hotspots = sorted.filter(function (x) { return x.durationMs > 0; }).slice(0, 3);
    }

    // 重试/重复模式
    var retries = [];
    Object.keys(sigMap).forEach(function (k) {
      if (sigMap[k].count >= RETRY_MIN) retries.push(sigMap[k]);
    });
    retries.sort(function (a, b) { return b.count - a.count; });

    // 失败模式（按 tool + error 归并）
    var failMap = {};
    failures.forEach(function (f) {
      var ne = normErr(f.error);
      var key = (f.tool || '') + '::' + ne;
      if (!failMap[key]) failMap[key] = { tool: f.tool || '', error: ne, count: 0, seqs: [] };
      failMap[key].count++;
      failMap[key].seqs.push(f.seq);
    });
    var failureModes = Object.keys(failMap).map(function (k) { return failMap[k]; })
      .sort(function (a, b) { return b.count - a.count; });

    var outcome = t.outcome || inferOutcome(successCount, failCount, steps.length);

    var summary = {
      taskId: t.taskId || '',
      profileId: t.profileId || '',
      goal: t.goal || '',
      outcome: outcome,
      stepCount: steps.length,
      successCount: successCount,
      failCount: failCount,
      totalDurationMs: totalDurationMs,
      avgStepMs: Math.round(avg),
      wallDurationMs: wallDurationMs(t),
      startedAt: t.startedAt || null,
      endedAt: t.endedAt || null,
    };

    return {
      ok: true,
      summary: summary,
      failureModes: failureModes,
      hotspots: hotspots,
      retries: retries,
      findings: buildFindings(summary, failureModes, hotspots, retries),
    };
  } catch (e) {
    return emptyAnalysis(input && typeof input === 'object' ? input : null);
  }
}

/**
 * 构造给「复盘 Agent」的 Prompt（含摘要、规则发现、步骤明细、输出结构要求）
 * @param {object|string} input trace 对象或 taskId
 * @returns {string}
 */
function buildRetrospectPrompt(input) {
  try {
    var t = resolveTrace(input);
    var analysis = analyzeTrace(t);
    var lines = [];

    lines.push('# 任务复盘请求');
    lines.push('');
    lines.push('你是复盘 Agent。下面是某次任务的执行轨迹与规则分析结果，请据此产出结构化复盘报告，用于改进后续同类任务。');
    lines.push('');

    lines.push('## 一、执行摘要');
    if (analysis && analysis.summary) {
      var s = analysis.summary;
      lines.push('- 任务目标：' + (s.goal || '(未记录)'));
      lines.push('- 结果：' + s.outcome + '（成功 ' + s.successCount + ' / 失败 ' + s.failCount + ' / 共 ' + s.stepCount + ' 步）');
      lines.push('- 总耗时：' + s.totalDurationMs + 'ms（平均每步 ' + s.avgStepMs + 'ms）');
    }
    lines.push('');

    lines.push('## 二、规则分析发现');
    if (analysis && analysis.findings && analysis.findings.length) {
      analysis.findings.forEach(function (f, i) {
        lines.push((i + 1) + '. [' + f.type + '/' + f.severity + '] ' + f.title);
        lines.push('   - 详情：' + f.detail);
        lines.push('   - 初步建议：' + f.suggestion);
      });
    } else {
      lines.push('（规则分析未发现明显问题）');
    }
    lines.push('');

    lines.push('## 三、执行步骤明细');
    if (t && Array.isArray(t.steps) && t.steps.length) {
      var shown = t.steps.slice(0, MAX_PROMPT_STEPS);
      shown.forEach(function (st) {
        lines.push('- #' + st.seq + ' ' + (st.tool || '?') +
          ' [' + (st.success === false ? '失败' : '成功') + ']' +
          (typeof st.durationMs === 'number' ? ' ' + st.durationMs + 'ms' : '') +
          (st.error ? ' err=' + truncate(st.error, 80) : ''));
      });
      if (t.steps.length > MAX_PROMPT_STEPS) {
        lines.push('...（共 ' + t.steps.length + ' 步，仅显示前 ' + MAX_PROMPT_STEPS + ' 步）');
      }
    } else {
      lines.push('（无步骤明细）');
    }
    lines.push('');

    lines.push('## 四、请输出（严格按以下结构）');
    lines.push('### 1. 执行摘要');
    lines.push('一句话概括任务执行过程与结果。');
    lines.push('');
    lines.push('### 2. 三个可优化点');
    lines.push('恰好列出 3 个最值得优化的点。每个点按「问题 → 根因 → 具体方案」三段式给出，');
    lines.push('方案须落到以下三类之一（或组合）：');
    lines.push('- Prompt 修改：如何调整提示词以避免该问题；');
    lines.push('- 步骤调整：如何合并/拆分/重排执行步骤；');
    lines.push('- 错误处理补充：失败时如何校验、重试或降级。');
    lines.push('');
    lines.push('### 3. 沉淀建议');
    lines.push('若本次经验可复用，建议提炼为 Skill（skill_create）或记录为教训（lesson_record），并给出名称与一句话描述。');
    lines.push('');

    return lines.join('\n');
  } catch (e) {
    return '';
  }
}

/** 给单条轨迹摘要打分（越高越值得复盘） */
function scoreTrace(s) {
  var score = 0;
  if (!s) return 0;
  if (s.outcome === 'failed') score += 50;
  else if (s.outcome === 'partial') score += 30;
  score += num(s.errorCount) * 10;
  if (num(s.durationMs) > 60000) score += 10;
  if (num(s.stepCount) > 30) score += 5;
  return score;
}

/**
 * 列出「值得复盘」的轨迹摘要（非全成功 / 有错误 / 长耗时 / 步骤多）
 * @param {number} [limit] 上限
 * @returns {Array} trace 摘要数组（按值得度降序）
 */
function listOptimizableTraces(limit) {
  try {
    var list = trace.listTraces();
    var scored = [];
    for (var i = 0; i < list.length; i++) {
      var sc = scoreTrace(list[i]);
      if (sc > 0) scored.push({ score: sc, trace: list[i] });
    }
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return Date.parse(b.trace.startedAt || 0) - Date.parse(a.trace.startedAt || 0);
    });
    var out = scored.map(function (x) { return x.trace; });
    if (typeof limit === 'number' && limit > 0) out = out.slice(0, limit);
    return out;
  } catch (e) {
    return [];
  }
}

module.exports = {
  analyzeTrace,
  buildRetrospectPrompt,
  listOptimizableTraces,
  scoreTrace,
  HOTSPOT_RATIO,
  HOTSPOT_MIN_MS,
  RETRY_MIN,
  MAX_PROMPT_STEPS,
};
