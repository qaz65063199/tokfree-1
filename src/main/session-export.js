/**
 * 会话导出：把会话消息序列化为 Markdown / JSON 并写入文件。
 * 纯数据侧实现（只依赖 fs/path/os），便于单测；默认输出目录为系统下载目录。
 * 消息内容不来自本模块——webview 端消息由调用方（渲染进程 / preload）采集后传入。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/** 取默认输出目录（Electron downloads，回退 ~/Downloads） */
function defaultOutDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      const dir = app.getPath('downloads');
      if (dir) return dir;
    }
  } catch (_) { /* 非 Electron 环境（单测）回退 */ }
  return path.join(os.homedir(), 'Downloads');
}

/** 清理文件名中的非法字符 */
function safeName(s) {
  return String(s || 'session').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

/** 格式化为 Markdown 文本 */
function toMarkdown(sessionId, messages, aliases) {
  const alias = (aliases && aliases[sessionId]) || '';
  const lines = [];
  lines.push('# 会话导出：' + (alias ? alias + '（' + sessionId + '）' : sessionId));
  lines.push('');
  lines.push('> 导出时间：' + new Date().toISOString());
  lines.push('> 消息数：' + (Array.isArray(messages) ? messages.length : 0));
  lines.push('');
  lines.push('---');
  lines.push('');
  const arr = Array.isArray(messages) ? messages : [];
  for (const msg of arr) {
    const role = (msg && (msg.role || msg.sender)) || 'unknown';
    const time = (msg && (msg.time || msg.timestamp)) || '';
    const head = '## ' + role + (time ? '  (' + time + ')' : '');
    lines.push(head);
    lines.push('');
    lines.push(String((msg && (msg.content || msg.text)) || ''));
    lines.push('');
  }
  return lines.join('\n');
}

/** 构造 JSON 结构 */
function toJsonObj(sessionId, messages, aliases) {
  return {
    sessionId,
    alias: (aliases && aliases[sessionId]) || '',
    exportedAt: new Date().toISOString(),
    messageCount: Array.isArray(messages) ? messages.length : 0,
    messages: Array.isArray(messages) ? messages : [],
  };
}

/**
 * 导出会话到文件
 * @param {string} sessionId 会话 ID
 * @param {Array} messages 消息数组（由调用方从 webview 采集）
 * @param {string} format 'markdown' | 'md' | 'json'（默认 markdown）
 * @param {string} [outPath] 输出文件完整路径；缺省则写默认目录
 * @param {object} [aliases] 会话别名映射（用于 Markdown 标题 / JSON alias 字段）
 * @returns {{ success:boolean, path?:string, error?:string }}
 */
function exportSession(sessionId, messages, format, outPath, aliases) {
  try {
    if (!sessionId) return { success: false, error: '缺少会话ID' };
    const fmt = String(format || 'markdown').toLowerCase();
    const isJson = fmt === 'json';
    let target = outPath;
    if (!target) {
      const ext = isJson ? '.json' : '.md';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      target = path.join(defaultOutDir(), safeName(sessionId) + '-' + stamp + ext);
    }
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const text = isJson
      ? JSON.stringify(toJsonObj(sessionId, messages, aliases), null, 2)
      : toMarkdown(sessionId, messages, aliases);
    fs.writeFileSync(target, text, 'utf-8');
    return { success: true, path: target };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { exportSession, toMarkdown, toJsonObj, defaultOutDir };
