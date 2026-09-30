const { Tool, ToolResult } = require('./ToolRegistry');

/**
 * ShardX 反检测浏览器工具（open / read / close）
 *
 * 方案A：用 ShardX（引擎级反检测浏览器，patched Chromium，经 MCP 接入）替代
 * 内置 Electron 浏览器，打开/读取敏感或易被反爬拦截的外部网站。
 *
 * 底层通过 mcp-client.callMcpTool("shardx", "<tool>", {...}) 调用 ShardX MCP。
 * 返回值多为 JSON 字符串，这里做安全解析（解析失败原样返回）。
 */

const SERVER = 'shardx';
const MAX_OUTPUT_CHARS = 20000;

// 测试时可注入 mock（见 test/tools/ShardXBrowserTool.test.js）。
let _mcpClientOverride = null;
function getMcpClient() {
  if (_mcpClientOverride) return _mcpClientOverride;
  return require('../src/main/mcp-client');
}
function __setMcpClient(client) {
  _mcpClientOverride = client;
}

// ShardX 就位管理器（延迟 require，避免测试环境加载 electron）。
let _mgrOverride = null;
function getShardxManager() {
  if (_mgrOverride) return _mgrOverride;
  return require('../src/main/shardx-manager');
}
function __setShardxManager(mgr) {
  _mgrOverride = mgr;
}

/**
 * 「用点即自愈」：调用任一 ShardX 工具前先确保 Launcher 就绪。
 * 返回 null 表示就绪；否则返回 ToolResult.error(...)。
 */
async function ensureReady() {
  // 测试模式（注入了 mcp client mock）：跳过就位检查，避免测试环境触发安装/启动。
  if (_mcpClientOverride) return null;
  try {
    const mgr = getShardxManager();
    if (!mgr || typeof mgr.ensureShardxReady !== 'function') return null;
    const ready = await mgr.ensureShardxReady();
    if (ready && ready.ok) return null;
    const detail = (ready && ready.error) || '';
    return ToolResult.error('ShardX 未就绪：' + detail + '（请确认已安装 ShardX Launcher，或点设置里重试）');
  } catch (e) {
    // 就位检查自身失败不阻断（让后续真实调用报出更具体的错）
    return null;
  }
}

/** 从 callMcpTool 的返回结构里提取纯文本（content[].text 拼接）。 */
function extractText(result) {
  const content = (result && result.content) || [];
  let text = '';
  for (const item of content) {
    if (item && item.type === 'text' && typeof item.text === 'string') {
      text += (text ? '\n' : '') + item.text;
    }
  }
  return text;
}

/** 安全 JSON 解析：失败则返回 null。 */
function safeParse(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return null;
  }
}

/**
 * 调用一个 ShardX MCP 工具。
 * @returns {{ text: string, parsed: any }}
 */
async function callShardx(tool, args) {
  const client = getMcpClient();
  const result = await client.callMcpTool(SERVER, tool, args || {});
  if (result && result.isError) {
    const t = extractText(result) || 'ShardX 工具返回错误';
    throw new Error(SERVER + '.' + tool + ': ' + t);
  }
  const text = extractText(result);
  return { text, parsed: safeParse(text) };
}

/** 兼容多种字段名解析 profile id。 */
function extractProfileId(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') return obj;
  const direct = obj.id || obj.profile_id || obj.profileId;
  if (direct) return direct;
  if (obj.profile && typeof obj.profile === 'object') {
    return obj.profile.id || obj.profile.profile_id || obj.profile.profileId || null;
  }
  return null;
}

/** 兼容数组 / {profiles:[]} / {items:[]} 三种返回形态。 */
function extractProfilesList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.profiles)) return parsed.profiles;
  if (parsed && Array.isArray(parsed.items)) return parsed.items;
  return [];
}

/** 在已有 profile 列表里按 id 或 name 查找。 */
function findProfile(profiles, wanted) {
  if (!wanted) return null;
  for (const p of profiles) {
    if (!p || typeof p !== 'object') continue;
    const pid = p.id || p.profile_id || p.profileId;
    if (pid === wanted || p.name === wanted) return p;
  }
  return null;
}

/** 截断到上限并附 footer。 */
function truncate(text) {
  const s = typeof text === 'string' ? text : String(text == null ? '' : text);
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return s.slice(0, MAX_OUTPUT_CHARS) + '\n\n(内容已截断，可用 selector 精确读取部分内容。)';
}

/** ShardX 不可用时的友好错误。 */
function friendlyError(err) {
  const msg = (err && err.message) || String(err);
  if (/ECONNREFUSED|connect|拒绝|ENOENT|not.*connect|fetch failed|socket/i.test(msg)) {
    return 'ShardX 连接失败（请确认 ShardX Launcher 正在运行）：' + msg;
  }
  return 'ShardX 调用失败：' + msg;
}

// ---------------------------------------------------------------------------
// open_shardx_browser
// ---------------------------------------------------------------------------

class OpenShardXBrowserTool extends Tool {
  constructor() {
    super(
      'open_shardx_browser',
      '用 ShardX 反检测浏览器打开外部网站（自动创建/复用 profile 并导航），返回 { profile_id, url, message }。后续用 read_shardx_page(profile_id) 读取内容、close_shardx_browser(profile_id) 关闭。',
      {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要打开的网页 URL' },
          id: { type: 'string', description: '（可选）自定义 profile 名/ID，便于语义化复用；不提供则创建临时 profile' },
          headless: { type: 'boolean', description: '（可选）是否无头运行，默认 false' }
        },
        required: ['url'],
        additionalProperties: false
      },
      'open_shardx_browser(url, options?)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:open_shardx_browser',
      order: 113,
      text: [
        '使用 openShardXBrowser 打开外部网站（ShardX 反检测浏览器）。返回 profile_id，后续用 read_shardx_page(profile_id) 读取内容、close_shardx_browser(profile_id) 关闭。',
        '调研/抓取被反爬拦截的外部网站时优先用它（替代内置 openBrowserWindow）。'
      ].join(String.fromCharCode(10))
    };
  }

  async execute(params) {
    const { url, id, headless } = params || {};
    try {
      const notReady = await ensureReady();
      if (notReady) return notReady;
      if (!url || typeof url !== 'string') {
        return ToolResult.error('url 不能为空');
      }

      let profileId = null;

      // 1) 若提供 id，先查是否已有同名/同 id 的 profile 可复用
      if (id) {
        try {
          const listed = await callShardx('list_profiles', {});
          const match = findProfile(extractProfilesList(listed.parsed), id);
          if (match) profileId = extractProfileId(match);
        } catch (_) {
          // 列表查询失败不阻断，退化为新建
        }
      }

      // 2) 没有可复用的则创建临时 profile
      if (!profileId) {
        const name = id || ('tokfree-' + Date.now());
        const created = await callShardx('create_temporary_profile', { name });
        profileId = extractProfileId(created.parsed);
        if (!profileId && typeof created.text === 'string' && created.text.trim()) {
          // 极端兜底：返回体本身就是一个裸 id 字符串
          profileId = created.text.trim();
        }
      }

      if (!profileId) {
        return ToolResult.error('创建 ShardX profile 失败：未解析到 profile id');
      }

      // 3) 导航
      await callShardx('browser_navigate', {
        profile_id: profileId,
        url,
        headless: !!headless
      });

      return ToolResult.success({
        profile_id: profileId,
        url,
        message: 'ShardX 浏览器已打开，profile_id: ' + profileId
      });
    } catch (err) {
      return ToolResult.error(friendlyError(err));
    }
  }
}

// ---------------------------------------------------------------------------
// read_shardx_page
// ---------------------------------------------------------------------------

class ReadShardXPageTool extends Tool {
  constructor() {
    super(
      'read_shardx_page',
      '读取 ShardX 浏览器中当前页面的内容。options 可含 { selector, mode }：mode=text（默认，返回正文文本，可配 selector）/ html（整页 HTML）/ url（当前 URL + title）。',
      {
        type: 'object',
        properties: {
          profile_id: { type: 'string', description: 'open_shardx_browser 返回的 profile_id' },
          selector: { type: 'string', description: '（可选）CSS 选择器，读取该元素的 innerText' },
          mode: { type: 'string', enum: ['text', 'html', 'url'], description: '读取模式，默认 text' }
        },
        required: ['profile_id'],
        additionalProperties: false
      },
      'read_shardx_page(profile_id, options?)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:read_shardx_page',
      order: 114,
      text: '使用 readShardXPage(profile_id, options?) 读取 ShardX 页面内容。默认返回正文文本；options.mode 可选 text/html/url；options.selector 可精确读取某元素。内容超约 20000 字符会截断。'
    };
  }

  async execute(params) {
    const { profile_id, selector, mode } = params || {};
    try {
      const notReady = await ensureReady();
      if (notReady) return notReady;
      if (!profile_id || typeof profile_id !== 'string') {
        return ToolResult.error('profile_id 不能为空');
      }

      const m = mode || 'text';

      if (m === 'url') {
        const r = await callShardx('browser_current_url', { profile_id });
        return ToolResult.success(r.text);
      }

      if (m === 'html') {
        const r = await callShardx('browser_content', { profile_id });
        return ToolResult.success(truncate(r.text));
      }

      // 默认 text
      const r = await callShardx('browser_get_text', {
        profile_id,
        selector: selector || 'body'
      });
      return ToolResult.success(truncate(r.text));
    } catch (err) {
      return ToolResult.error(friendlyError(err));
    }
  }
}

// ---------------------------------------------------------------------------
// close_shardx_browser
// ---------------------------------------------------------------------------

class CloseShardXBrowserTool extends Tool {
  constructor() {
    super(
      'close_shardx_browser',
      '关闭指定 profile 的 ShardX 浏览器（graceful stop）。',
      {
        type: 'object',
        properties: {
          profile_id: { type: 'string', description: '要关闭的 profile_id' }
        },
        required: ['profile_id'],
        additionalProperties: false
      },
      'close_shardx_browser(profile_id)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:close_shardx_browser',
      order: 115,
      text: '使用 closeShardXBrowser(profile_id) 关闭 ShardX 浏览器（用完及时关闭，释放资源）。'
    };
  }

  async execute(params) {
    const { profile_id } = params || {};
    try {
      const notReady = await ensureReady();
      if (notReady) return notReady;
      if (!profile_id || typeof profile_id !== 'string') {
        return ToolResult.error('profile_id 不能为空');
      }
      const r = await callShardx('stop_profile', { id: profile_id });
      return ToolResult.success(r.text || ('已关闭 ShardX profile: ' + profile_id));
    } catch (err) {
      return ToolResult.error(friendlyError(err));
    }
  }
}

module.exports = {
  OpenShardXBrowserTool,
  ReadShardXPageTool,
  CloseShardXBrowserTool,
  __setMcpClient,
  __setShardxManager
};
