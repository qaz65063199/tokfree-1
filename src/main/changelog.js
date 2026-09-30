/**
 * 更新日志（CHANGELOG.md）读取 / 解析 / 弹窗
 * - getChangelog(): 读 CHANGELOG.md → 解析为 [{ version, date, body }]（新→旧）
 * - openChangelogWindow(): 打开「更新日志」弹窗（多版本标签页）
 * 打包路径参考 shardx-manager.js（app.isPackaged 时用 process.resourcesPath）。
 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { logger } = require('../core/logger');

/** 候选路径：打包后 resources/ 优先，开发态回退到应用根目录 */
function resolveChangelogPath() {
  const candidates = [];
  try {
    if (app && app.isPackaged && process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'CHANGELOG.md'));
    }
  } catch (_) {}
  try {
    // __dirname = <root>/src/main → 上两级为应用根
    candidates.push(path.join(__dirname, '..', '..', 'CHANGELOG.md'));
  } catch (_) {}
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

/**
 * 解析 CHANGELOG.md 为版本数组
 * 规则：按二级标题 `## [x.y.z] - date` 切块；块内剩余文本作为 body（含 ### 小节 / 列表）
 * @returns {Array<{version:string, date:string, body:string}>}
 */
function parseChangelog(md) {
  const text = String(md || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const versions = [];
  // 以 '## ' 开头的标题切块（parts[0] 是标题前的 # Changelog 前言）
  const parts = text.split(/^##\s+/m);
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const nl = block.indexOf('\n');
    const header = (nl === -1 ? block : block.slice(0, nl)).trim();
    const body = (nl === -1 ? '' : block.slice(nl + 1)).trim();
    // header 形如：[0.9.0] - 2026-09-30 / 0.9.0 - 2026-09-30 / Unreleased
    const m = header.match(/^\[?([^\]\s]+)\]?\s*(?:[-–—]\s*(.+))?$/);
    if (!m) continue;
    const version = m[1];
    const date = (m[2] || '').trim();
    // 只保留形如 x.y.z 的版本号（跳过 Unreleased / 非版本标题）
    if (!/^\d+(\.\d+)+/.test(version)) continue;
    versions.push({ version, date, body });
  }
  return versions;
}

/** 读取并解析 CHANGELOG.md */
function getChangelog() {
  try {
    const p = resolveChangelogPath();
    if (!p) return { success: false, error: 'CHANGELOG.md 未找到', versions: [] };
    const md = fs.readFileSync(p, 'utf-8');
    const versions = parseChangelog(md);
    return { success: true, versions };
  } catch (err) {
    logger.error('[TokFree] 读取 CHANGELOG 失败:', err && err.message);
    return { success: false, error: err && err.message, versions: [] };
  }
}

let changelogWin = null;

/** 打开「更新日志」弹窗（已开则聚焦） */
function openChangelogWindow() {
  try {
    if (changelogWin && !changelogWin.isDestroyed()) {
      changelogWin.show();
      changelogWin.focus();
      return { success: true };
    }
    const preloadPath = path.join(__dirname, '..', 'preload', 'changelog-preload.js');
    const htmlPath = path.join(__dirname, '..', 'ui', 'changelog.html');
    changelogWin = new BrowserWindow({
      width: 720,
      height: 720,
      minWidth: 480,
      minHeight: 400,
      title: 'TokFree 更新日志',
      backgroundColor: '#0e0f1a',
      modal: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    // 尺寸约 720px × 80vh
    try {
      const { screen } = require('electron');
      const disp = screen.getPrimaryDisplay();
      const h = Math.max(400, Math.round((disp.workAreaSize.height || 900) * 0.8));
      changelogWin.setBounds({ width: 720, height: h });
    } catch (_) {}
    changelogWin.loadFile(htmlPath).catch(err => {
      logger.error('[TokFree] 加载更新日志窗口失败:', err && err.message);
    });
    changelogWin.on('closed', () => { changelogWin = null; });
    return { success: true };
  } catch (err) {
    logger.error('[TokFree] 打开更新日志窗口失败:', err && err.message);
    return { success: false, error: err && err.message };
  }
}

module.exports = { getChangelog, openChangelogWindow, parseChangelog };
