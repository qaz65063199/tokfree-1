'use strict';

/**
 * 轻量级行级 diff（LCS）。
 * 生成 unified diff 文本，用于 edit/write 的结果回传与 dryRun 预览。
 * 纯 Node，无第三方依赖。
 */

/** 计算两行的相等性（严格字符串比较）。 */
function linesEqual(a, b) {
  return a === b;
}

/**
 * LCS 动态规划，返回最长公共子序列在 a/b 中的索引对。
 * 为控制内存，超过 limit 行时退化为"整块替换"策略。
 * @param {string[]} a
 * @param {string[]} b
 * @returns {{i:number,j:number}[]}
 */
function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  // 二维 DP 表（n+1)*(m+1)，值 uint32
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    dp[i] = new Uint32Array(m + 1);
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }
  // 回溯
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push({ i, j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * 生成行级操作序列：equal / del / add。
 * @param {string[]} a 旧行
 * @param {string[]} b 新行
 * @returns {{type:'equal'|'del'|'add', text:string, aLine?:number, bLine?:number}[]}
 */
function diffOps(a, b) {
  // 大文件保护：超过 5000 行直接整块替换，避免 DP 内存爆炸
  if (a.length > 5000 || b.length > 5000) {
    const ops = [];
    for (let i = 0; i < a.length; i++) ops.push({ type: 'del', text: a[i], aLine: i + 1 });
    for (let j = 0; j < b.length; j++) ops.push({ type: 'add', text: b[j], bLine: j + 1 });
    return ops;
  }
  const pairs = lcsPairs(a, b);
  const ops = [];
  let ai = 0;
  let bi = 0;
  for (const p of pairs) {
    while (ai < p.i) { ops.push({ type: 'del', text: a[ai], aLine: ai + 1 }); ai++; }
    while (bi < p.j) { ops.push({ type: 'add', text: b[bi], bLine: bi + 1 }); bi++; }
    ops.push({ type: 'equal', text: a[ai], aLine: ai + 1, bLine: bi + 1 });
    ai++;
    bi++;
  }
  while (ai < a.length) { ops.push({ type: 'del', text: a[ai], aLine: ai + 1 }); ai++; }
  while (bi < b.length) { ops.push({ type: 'add', text: b[bi], bLine: bi + 1 }); bi++; }
  return ops;
}

/** 将文本按行切分（保留行内容，不含换行符）。 */
function splitLines(text) {
  if (text === '' || text === null || text === undefined) return [];
  return String(text).split(/\r?\n/);
}

/**
 * 生成 unified diff 文本。
 * @param {string} oldText 旧内容
 * @param {string} newText 新内容
 * @param {object} [opts]
 * @param {string} [opts.filePath] 文件路径（出现在 ---/+++ 头）
 * @param {number} [opts.context=3] 上下文行数
 * @param {number} [opts.maxLines=400] 最多输出的 diff 行数（超出截断并提示）
 * @returns {{diff:string, added:number, removed:number, changed:boolean, truncated:boolean}}
 */
function createUnifiedDiff(oldText, newText, opts) {
  const options = opts || {};
  const filePath = options.filePath || 'file';
  const context = Number.isInteger(options.context) ? options.context : 3;
  const maxLines = Number.isInteger(options.maxLines) ? options.maxLines : 400;

  const a = splitLines(oldText);
  const b = splitLines(newText);

  const ops = diffOps(a, b);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added++;
    else if (op.type === 'del') removed++;
  }
  const changed = added > 0 || removed > 0;
  if (!changed) {
    return { diff: '', added: 0, removed: 0, changed: false, truncated: false };
  }

  // 计算需要输出的行号区间（围绕变更行的上下文）
  const keep = new Array(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== 'equal') {
      for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) {
        keep[k] = true;
      }
    }
  }

  const out = [];
  out.push('--- ' + filePath + ' (old)');
  out.push('+++ ' + filePath + ' (new)');
  out.push('@@ added ' + added + ', removed ' + removed + ' @@');

  let lastWasGap = false;
  for (let i = 0; i < ops.length; i++) {
    if (!keep[i]) {
      if (!lastWasGap) { out.push('...'); lastWasGap = true; }
      continue;
    }
    lastWasGap = false;
    const op = ops[i];
    if (op.type === 'equal') out.push(' ' + op.text);
    else if (op.type === 'del') out.push('-' + op.text);
    else out.push('+' + op.text);
  }

  let truncated = false;
  if (out.length > maxLines) {
    truncated = true;
    const head = out.slice(0, maxLines);
    head.push('... (diff 过长，已截断，共 ' + out.length + ' 行)');
    return { diff: head.join('\n'), added, removed, changed: true, truncated };
  }
  return { diff: out.join('\n'), added, removed, changed: true, truncated };
}

module.exports = {
  createUnifiedDiff,
  diffOps,
  splitLines,
};
