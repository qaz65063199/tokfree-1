const { Tool, ToolResult } = require('./ToolRegistry');
const windowManager = require('./browser-window-manager');

class OpenBrowserWindowTool extends Tool {
  constructor() {
    super(
      'open_browser_window',
      '打开一个 Electron 浏览器窗口，返回 { windowId, message }，用返回的 windowId 传给 injectJS(windowId, code) 注入 JS 调试',
      {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要打开的网页 URL' },
          id: { type: 'string', description: '自定义窗口 ID（可选），不提供则自动生成' },
          width: { type: 'number', description: '窗口宽度（像素），默认 1200' },
          height: { type: 'number', description: '窗口高度（像素），默认 800' },
          partition: { type: 'string', description: '（可选）Electron session partition，用于复用已登录会话，如 persist:chatgpt:profile-xxx' }
        },
        required: ['url'],
        additionalProperties: false
      },
      'openBrowserWindow(url, options?)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:open_browser_window',
      order: 112,
      text: [
        '使用 openBrowserWindow 打开 Electron 浏览器窗口。返回 windowId，后续用 injectJS(windowId, code) 注入 JS 并获取返回值。可传自定义 id 便于语义化管理。',
        '',
        '## 何时才用它（重要）',
        '内置 Electron 浏览器容易被外部网站识别为机器人并拦截，**外部网站调研/抓取默认走 ShardX**（open_shardx_browser / read_shardx_page），不要用本工具。',
        '仅在需要 **TokFree 特性** 时才用 openBrowserWindow：',
        '- 驱动网页版 AI（hook 拦截 + 覆盖层 + 工具回执）；',
        '- 复用登录态（partition 参数，如 persist:chatgpt:profile-xxx）；',
        '- 打开本机 / 受信页面；',
        '- 需要 human_* 拟人输入配合覆盖层操作；',
        '- 本地 OpenAI API 相关。',
        '判断口径：任务是「取外部网站的信息」→ ShardX；任务是「操作本应用集成的 AI 网页」→ 本工具。'
      ].join(String.fromCharCode(10))
    };
  }

  async execute(params) {
    const { url, id, width, height, partition } = params;
    const options = {};
    if (width) options.width = width;
    if (height) options.height = height;
    if (partition) options.partition = partition;
    const windowId = windowManager.openWindow(id || null, url, options);
    return ToolResult.success({ windowId, message: `窗口已打开，ID: ${windowId}，URL: ${url}` });
  }
}

module.exports = { OpenBrowserWindowTool };
