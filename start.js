/**
 * 跨平台启动脚本
 * 捕获 Electron stdout/stderr 写入日志文件，避免 Chromium 在 cwd 生成 PID 日志
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const isWin = process.platform === 'win32';

// 创建 wyp/log 目录
const logDir = path.join(__dirname, 'wyp', 'log');
fs.mkdirSync(logDir, { recursive: true });

// 日志轮转：归档旧日志（保留最近 5 个带时间戳的），而不是清空
try {
  const KEEP = 5;
  // 先把当前 electron.log 重命名为带时间戳的归档（若存在且有内容）
  const cur = path.join(logDir, 'electron.log');
  if (fs.existsSync(cur)) {
    try {
      const st = fs.statSync(cur);
      if (st.size > 0) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        fs.renameSync(cur, path.join(logDir, 'electron-' + ts + '.log'));
      }
    } catch (_) {}
  }
  // 清理过旧的归档日志（保留最近 KEEP 个）
  const archives = fs.readdirSync(logDir)
    .filter(f => /^electron-.*\.log$/.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(logDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (let i = KEEP; i < archives.length; i++) {
    try { fs.unlinkSync(path.join(logDir, archives[i].f)); } catch (_) {}
  }
} catch (err) {
  console.warn('[start.js] 日志轮转失败:', err.message);
}

const logFile = path.join(logDir, 'electron.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

const cmd = isWin ? 'chcp 65001 > nul && electron .' : 'electron .';
const child = spawn(cmd, { shell: true, stdio: ['inherit', 'pipe', 'pipe'] });

child.stdout.pipe(logStream);
child.stderr.pipe(logStream);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

child.on('close', (code) => {
  logStream.end();
  process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error('启动失败:', err.message);
  process.exit(1);
});
