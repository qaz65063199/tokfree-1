const { BrowserWindow } = require('electron');

// 品牌图标（TF）：开发态引用 build/icon.ico；打包后 build/ 被 files 排除则回退为 undefined
// （此时窗口沿用可执行文件内嵌图标，视觉一致）。
const APP_ICON_PATH = (function () {
  try {
    const p = require('path').join(__dirname, '..', 'build', 'icon.ico');
    return require('fs').existsSync(p) ? p : undefined;
  } catch (_) {
    return undefined;
  }
})();

class BrowserWindowManager {
  constructor() {
    this.windows = new Map();
    this.nextAutoId = 1;
  }

  openWindow(customId, url, options = {}) {
    let id;
    if (customId) {
      if (this.windows.has(customId)) {
        throw new Error(`窗口 ID "${customId}" 已存在，请换一个 ID 或复用现有窗口`);
      }
      id = customId;
    } else {
      do {
        id = `win-${this.nextAutoId++}`;
      } while (this.windows.has(id));
    }

    const { partition, ...restOptions } = options;
    const winOptions = {
      width: options.width || 1200,
      height: options.height || 800,
      icon: APP_ICON_PATH, // 调用方若在 options 里传 icon，由下方 ...restOptions 覆盖
      ...restOptions,
      // 关闭后台节流，避免窗口被遮挡/锁屏时定时器与渲染被降频
      webPreferences: Object.assign({}, restOptions.webPreferences, {
        backgroundThrottling: false,
        // preload：在页面脚本执行前注入反自动化特征（window.chrome / 品牌头等）
        preload: require('path').join(__dirname, 'tool-window-preload.js'),
      }),
    };
    // partition 需放在 webPreferences 下，复用已登录会话（如 persist:chatgpt:profile-xxx）
    if (partition) {
      winOptions.webPreferences = Object.assign({}, winOptions.webPreferences, { partition });
    }
    const win = new BrowserWindow(winOptions);

    // 设置与主窗口一致的 Chrome 130 普通 UA，避免暴露 Electron 标识
    const userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    win.webContents.setUserAgent(userAgent);

    // 请求头修正：Sec-CH-UA 补 Google Chrome
    try {
      require('../src/main/browser-compat').applyHeaderFix(win.webContents.session, { os: 'win' });
    } catch (err) {
      console.error('[TokFree] 工具窗口请求头修正失败:', err && err.message);
    }

    // 反自动化特征修复改由 preload 完成（见上方 webPreferences.preload），
    // 它在任何页面脚本执行前运行，比 did-start-navigation/dom-ready 可靠。

    if (url) win.loadURL(url);
    this.windows.set(id, win);
    win.on('closed', () => this.windows.delete(id));
    return id;
  }

  async injectJS(id, jsCode) {
    const win = this.windows.get(id);
    if (!win) throw new Error(`窗口 ID "${id}" 不存在`);

    // 语法探测：优先按"单个表达式"解析，失败则按"函数体（多条语句）"解析
    // 既支持 `1+2`、`(() => {...})()` 这类表达式，
    // 也支持 `return x`、`const a=1; return a`、`if (...) return x`、顶层 await 等多语句代码
    let mode; // 'expression' | 'body'
    try {
      new Function('return (' + jsCode + '\n)');
      mode = 'expression';
    } catch (e1) {
      try {
        new Function('return (async () => {\n' + jsCode + '\n})');
        mode = 'body';
      } catch (e2) {
        throw new Error('JS 语法错误: ' + e2.message);
      }
    }

    let wrapped;
    if (mode === 'expression') {
      wrapped = `(async () => {
  try {
    const __result = await (${jsCode});
    return { ok: true, value: __result };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
})()`;
    } else {
      wrapped = `(async () => {
  try {
    const __result = await (async () => {
${jsCode}
    })();
    return { ok: true, value: __result };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
})()`;
    }
    const result = await win.webContents.executeJavaScript(wrapped, true);
    if (result && result.ok === false) {
      throw new Error(result.error);
    }
    return result ? result.value : undefined;
  }

  getWindow(id) {
    const win = this.windows.get(id);
    if (!win) throw new Error(`窗口 ID "${id}" 不存在`);
    return win;
  }

  getAllWindowIds() {
    return Array.from(this.windows.keys());
  }

  closeWindow(id) {
    const win = this.getWindow(id);
    win.close();
    this.windows.delete(id);
  }
}

module.exports = new BrowserWindowManager();
