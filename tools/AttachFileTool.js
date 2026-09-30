/**
 * 附件上传工具：把本地文件作为附件上传到当前网页版 AI 聊天。
 *
 * 用途：AI 生成图片/文件（如截图、生成的图表、下载的文件）后，
 * 通过附件形式发给网页版 AI（多模态模型可直接看图/读文件）。
 *
 * 说明：真正的 DOM 上传在 preload 里做（主进程无法直接操作页面 input）。
 * 本工具返回文件信息 + 标记，由回执触发 preload 侧的附件上传。
 */
const { Tool, ToolResult } = require('./ToolRegistry');
const fs = require('fs');
const path = require('path');

class AttachFileTool extends Tool {
  constructor() {
    super(
      'attach_file',
      '把本地文件（图片/PDF/文本等）作为附件上传到当前 AI 聊天。返回可识别的附件标记，回执时系统会自动上传。',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要上传的本地文件绝对路径' },
        },
        required: ['path'],
        additionalProperties: false
      },
      'attachFile(path)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:attach_file',
      order: 115,
      text: '使用 attachFile(path) 把本地文件作为附件上传到当前 AI 聊天（图片/PDF/文本等）。回执时系统会自动上传该文件。'
    };
  }

  async execute(params) {
    const { path: filePath } = params || {};
    if (!filePath || typeof filePath !== 'string') {
      return ToolResult.error('缺少 path 参数');
    }
    let abs = filePath;
    if (!path.isAbsolute(abs)) {
      const projectDir = params.projectDir || null;
      abs = projectDir ? path.join(projectDir, abs) : path.resolve(abs);
    }
    try {
      if (!fs.existsSync(abs)) return ToolResult.error('文件不存在: ' + abs);
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return ToolResult.error('不是文件: ' + abs);
      return ToolResult.success({
        path: abs,
        size: stat.size,
        name: path.basename(abs),
        // 附件标记：回执文本里带上这个，preload 会识别并上传
        marker: '【附件：' + abs + '】'
      });
    } catch (err) {
      return ToolResult.error('附件处理失败: ' + (err.message || String(err)));
    }
  }
}

module.exports = { AttachFileTool };
