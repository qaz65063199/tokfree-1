/**
 * 工具窗口（openBrowserWindow）的 preload
 *
 * 问题：之前用 webContents.on('did-start-navigation') + executeJavaScript 注入兼容脚本，
 * 但该事件触发时新文档尚未创建，脚本会落在正在被销毁的旧文档上（或被丢弃）；
 * dom-ready 又太晚（页面脚本已执行）。正确做法是用 preload（早于任何页面脚本）。
 *
 * 本 preload 把 browser-compat 脚本注入主世界。
 */
const { webFrame } = require('electron');

try {
  const { buildBrowserCompatScript } = require('../src/preload/browser-compat');
  const src = buildBrowserCompatScript();
  // 注入主世界（preload 默认在隔离世界，executeJavaScript 落到主世界）
  webFrame.executeJavaScript(src).then(
    () => {},
    (err) => console.error('[TokFree Tool] 兼容注入失败:', err && err.message)
  );
} catch (err) {
  console.error('[TokFree Tool] 加载兼容模块失败:', err && err.message);
}
