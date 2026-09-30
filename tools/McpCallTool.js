const { Tool, ToolResult } = require('./ToolRegistry');

/**
 * MCP 调用工具 - 让 AI 通过 mcpCall 调用外部 MCP server 的工具。
 */
class McpCallTool extends Tool {
  constructor() {
    super(
      'mcp_call',
      '调用 MCP server 提供的工具。传入 server 名称、工具名和参数。',
      {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP server 名称' },
          tool: { type: 'string', description: '要调用的工具名' },
          args: { type: 'object', description: '工具参数对象' }
        },
        required: ['server', 'tool'],
        additionalProperties: false
      },
      'mcpCall(server, tool, args)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:mcp',
      order: 118,
      text: [
        '调用 MCP 工具时使用 mcpCall(server, tool, args)。使用前先通过 mcpListServers() 和 mcpGetTools() 查询可用能力。',
        '',
        '## ShardX 反检测浏览器（server 名：shardx）—— 外部网站调研默认用它',
        '内置 MCP server「shardx」提供**引擎级反检测浏览器**（patched Chromium，指纹伪装在 C++ 层，比本项目的 JS 层注入更强）。**除下面「内置浏览器场景」外，打开外部网站默认一律走 ShardX**（尤其调研/抓取被反爬拦截、机器人检测、注册账号、多账号、需要强指纹伪装时）。',
        '- **优先用便捷工具**（已封装，无需自己拼 mcpCall）：',
        '  - open_shardx_browser(url, options?) —— 打开外部网站（自动建/复用 profile、导航），返回 profile_id。',
        '  - read_shardx_page(profile_id, options?) —— 读取当前页面内容（文本/Markdown）。',
        '  - close_shardx_browser(profile_id) —— 关闭。',
        '- 需要更细粒度控制（拟人输入、截图、多标签、Cookie 等）时，直接 mcpCall("shardx", ...)：',
        '  - create_profile / browser_navigate / browser_text / browser_evaluate / browser_screenshot 等。',
        '  - 拟人输入用 human_* 系列（human_click/human_move/human_fill/human_type）：真实指针轨迹（Fitts 定律）+ 逐键输入，在浏览器进程内产生，**不注入页面**。',
        '  - 所有 shardx 工具第一个参数是 profile_id（先用 list_profiles 或 create_profile 拿）。',
        '- 前提：ShardX Launcher 需在运行（它提供本地 API）。若调用报连接失败，提示用户启动 ShardX Launcher，或视情降级为内置浏览器。',
        '',
        '## 与内置浏览器（openBrowserWindow）的分工边界',
        '- **用 ShardX**：外部网站调研、被风控/机器人检测拦截、注册/多账号、需要强指纹伪装、webFetch 被反爬挡回。',
        '- **用内置 openBrowserWindow（Electron）**：仅当需要 TokFree 特性时——驱动网页版 AI（hook/覆盖层/工具回执）、复用登录态（partition）、打开本机/受信页面、需要 human_* 拟人输入配合覆盖层、本地 OpenAI API 相关。',
        '- 判断口径：**任务是「取外部网站的信息」→ ShardX；任务是「操作本应用集成的 AI 网页」→ 内置浏览器**。'
      ].join(String.fromCharCode(10))
    };
  }

  async execute(params) {
    const { server, tool, args } = params;
    try {
      if (!server || typeof server !== 'string') {
        return ToolResult.error('server 不能为空');
      }
      if (!tool || typeof tool !== 'string') {
        return ToolResult.error('tool 不能为空');
      }
      // ShardX 用点即自愈：调用 shardx server 前先确保 Launcher 就绪。
      if (server === 'shardx') {
        try {
          const mgr = require('../src/main/shardx-manager');
          if (mgr && typeof mgr.ensureShardxReady === 'function') {
            const ready = await mgr.ensureShardxReady();
            if (!ready || !ready.ok) {
              const detail = (ready && ready.error) || '';
              return ToolResult.error('ShardX 未就绪：' + detail + '（请确认已安装 ShardX Launcher，或点设置里重试）');
            }
          }
        } catch (_) {
          // 就位检查失败不阻断，让真实调用给出具体错误
        }
      }
      const mcpClient = require('../src/main/mcp-client');
      const result = await mcpClient.callMcpTool(server, tool, args || {});

      // 提取纯文本内容
      const content = result.content || [];
      let text = '';
      let hasNonText = false;
      for (const item of content) {
        if (item && item.type === 'text' && typeof item.text === 'string') {
          text += (text ? '\n' : '') + item.text;
        } else if (item) {
          hasNonText = true;
        }
      }

      if (result.isError) {
        // 错误友好化：把错误信息作为失败返回
        const errText = text || 'MCP 工具返回错误';
        return ToolResult.error(server + '.' + tool + ': ' + errText);
      }

      // 成功：返回纯文本，若有非文本内容则附带提示
      return ToolResult.success(text);
    } catch (err) {
      return ToolResult.error('MCP 调用失败: ' + (err.message || String(err)));
    }
  }
}

module.exports = { McpCallTool };
