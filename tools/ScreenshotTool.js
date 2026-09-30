/**
 * 截图工具：对指定窗口截图并保存为 PNG 临时文件，供 AI 以附件形式上传。
 *
 * 用途：AI 遇到无法通过代码获取用户界面信息时（如页面渲染异常、验证码、
 * 复杂 UI 状态），截图后作为附件发给网页版 AI（多模态模型可直接看图）。
 *
 * 截图来源（按 windowId 区分）：
 * - 传 windowId → 截 browser-window-manager 管理的窗口
 * - 不传 → 截 AI 调用者自己所在的窗口（__callerProfileId）
 */
const { Tool, ToolResult } = require('./ToolRegistry');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const windowManager = require('./browser-window-manager');

function getShotDir() {
  const dir = path.join(app.getPath('userData'), 'screenshots');
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

class ScreenshotTool extends Tool {
  constructor() {
    super(
      'screenshot',
      '对指定窗口截图并保存为 PNG 文件，返回文件绝对路径。用于 AI 无法通过代码获取界面信息时（页面异常/验证码/复杂UI），截图后作为附件发给 AI 看。',
      {
        type: 'object',
        properties: {
          windowId: { type: 'string', description: '要截图的窗口 ID（openBrowserWindow 返回的）。不传则截当前 AI 所在窗口。' },
        },
        additionalProperties: false
      },
      'screenshot(windowId?)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:screenshot',
      order: 114,
      text: [
        '使用 screenshot(windowId?) 对窗口截图并保存为 PNG 文件，返回文件绝对路径。',
        '- 适用场景：你无法通过代码获取界面信息（页面渲染异常、出现验证码、复杂 UI 状态、需要"看"页面才能判断）。',
        '- 不传 windowId 则截当前窗口；传 openBrowserWindow 返回的 windowId 则截那个窗口。',
        '- 截图后，把返回的路径写进你的回复或代码块输出即可，系统会自动把该图片作为附件上传给 AI（多模态模型可直接看图）。',
        '- 也可用 attachFile(path) 主动把任意本地文件（图片/PDF等）作为附件上传。',
      ].join(String.fromCharCode(10))
    };
  }

  async execute(params) {
    const { windowId, __callerProfileId } = params || {};
    let win = null;
    let src = '';

    // 1) 指定 windowId（browser-window-manager 管理的窗口）
    if (windowId) {
      try { win = windowManager.getWindow(windowId); src = 'windowId=' + windowId; } catch (_) {}
    }
    // 2) 否则截调用者自己的窗口
    if (!win && __callerProfileId) {
      try {
        const ctx = require('../src/main/window').getWindowByProfileId(__callerProfileId);
        if (ctx && ctx.win && !ctx.win.isDestroyed()) { win = ctx.win; src = 'caller=' + __callerProfileId; }
      } catch (_) {}
    }
    if (!win || win.isDestroyed()) {
      return ToolResult.error('找不到可截图的窗口' + (windowId ? '（windowId=' + windowId + '）' : '（无调用者窗口）'));
    }

    try {
      const image = await win.webContents.capturePage();
      if (!image || image.isEmpty()) return ToolResult.error('截图失败：图像为空');
      const png = image.toPNG();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(getShotDir(), 'shot-' + stamp + '.png');
      fs.writeFileSync(file, png);
      const w = image.getSize().width, h = image.getSize().height;
      return ToolResult.success({
        path: file,
        width: w,
        height: h,
        size: png.length,
        source: src,
        message: '截图已保存：' + file + '（' + w + 'x' + h + '，' + Math.round(png.length / 1024) + 'KB）'
      });
    } catch (err) {
      return ToolResult.error('截图异常: ' + (err.message || String(err)));
    }
  }
}

module.exports = { ScreenshotTool };
