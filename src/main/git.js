/**
 * Git 集成（对标 Cursor / Cline）
 * 封装只读的 git 查询命令：状态 / 分支 / 最近提交 / diff。
 * 所有命令都用 execFile 指定 cwd，不依赖 shell 展开；非 git 仓库优雅返回。
 */
const { execFile } = require('child_process');

/**
 * 在指定 cwd 下执行 git 命令。
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, error?:string}>}
 */
function runGit(args, cwd) {
  return new Promise((resolve) => {
    if (!cwd || typeof cwd !== 'string') {
      return resolve({ ok: false, stdout: '', stderr: '', error: '未指定项目目录' });
    }
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 8 }, (err, stdout, stderr) => {
      if (err) {
        // 常见：非 git 仓库 / git 未安装
        const msg = (stderr && String(stderr).trim()) || err.message || 'git 执行失败';
        return resolve({ ok: false, stdout: String(stdout || ''), stderr: String(stderr || ''), error: msg });
      }
      resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** 解析 git status --porcelain 的一行 → { path, status, staged } */
function parsePorcelainLine(line) {
  // 格式：XY <path>（XY 为两列状态码，第 1 列暂存区，第 2 列工作区）
  if (!line || line.length < 4) return null;
  const x = line[0];
  const y = line[1];
  let file = line.substring(3);
  // 重命名/拷贝： "R  old -> new"
  if ((x === 'R' || x === 'C' || y === 'R' || y === 'C') && file.indexOf(' -> ') !== -1) {
    file = file.split(' -> ').pop();
  }
  // 去引号（含特殊字符时 git 会加引号）
  file = file.replace(/^"(.*)"$/, '$1');
  return { path: file, index: x, working: y };
}

/** 把两列状态码归一化为 modified/added/deleted/renamed/untracked/conflict */
function classify(entry) {
  const { index, working } = entry;
  if (index === '?' && working === '?') return 'untracked';
  if (index === 'U' || working === 'U' || (index === 'A' && working === 'A') || (index === 'D' && working === 'D')) return 'conflict';
  const codes = index + working;
  if (codes.indexOf('R') !== -1) return 'renamed';
  if (codes.indexOf('D') !== -1) return 'deleted';
  if (codes.indexOf('A') !== -1) return 'added';
  if (codes.indexOf('M') !== -1) return 'modified';
  return 'other';
}

/**
 * 查询 git 工作区状态（分支 + 变更文件列表 + 是否 git 仓库）。
 * @param {string} cwd 项目目录
 */
async function getStatus(cwd) {
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { isRepo: false, branch: null, files: [], error: inside.error || null };
  }

  const [branchRes, statusRes] = await Promise.all([
    runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    runGit(['status', '--porcelain'], cwd)
  ]);

  const branch = branchRes.ok ? branchRes.stdout.trim() : null;
  const files = [];
  if (statusRes.ok) {
    for (const line of statusRes.stdout.split('\n')) {
      if (!line.trim()) continue;
      const entry = parsePorcelainLine(line);
      if (!entry) continue;
      files.push({
        path: entry.path,
        status: classify(entry),
        index: entry.index,
        working: entry.working
      });
    }
  }

  return { isRepo: true, branch, files, error: null };
}

/**
 * 最近提交（oneline）。
 * @param {string} cwd
 * @param {number} limit 默认 20
 */
async function getLog(cwd, limit = 20) {
  const n = Number.isInteger(limit) && limit > 0 ? limit : 20;
  const res = await runGit(['log', '--oneline', '-n', String(n)], cwd);
  if (!res.ok) return { commits: [], error: res.error || null };
  const commits = res.stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const idx = l.indexOf(' ');
      if (idx === -1) return { hash: l.trim(), subject: '' };
      return { hash: l.substring(0, idx), subject: l.substring(idx + 1) };
    });
  return { commits, error: null };
}

/**
 * 查看某文件 diff（工作区 vs HEAD，未暂存部分）。
 * @param {string} cwd
 * @param {string} file 相对路径
 */
async function getDiff(cwd, file) {
  if (!file || typeof file !== 'string') {
    return { diff: '', error: '缺少文件路径' };
  }
  const res = await runGit(['diff', '--', file], cwd);
  if (!res.ok) return { diff: '', error: res.error || null };
  return { diff: res.stdout, error: null };
}

module.exports = { runGit, getStatus, getLog, getDiff, parsePorcelainLine, classify };
