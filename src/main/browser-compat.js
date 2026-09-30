/**
 * 浏览器兼容（主进程侧）：同步 HTTP 请求头
 *
 * 问题：JS 层用 navigator.userAgentData.brands 补了 "Google Chrome"（见 preload/browser-compat.js），
 * 但 HTTP 请求头 Sec-CH-UA 是 Chromium C++ 层根据 UA 自动生成的，仍然是 "Chromium"。
 * 检测方只要对比「请求头」与「JS 读数」就能发现矛盾。
 *
 * 本模块用 session.webRequest.onBeforeSendHeaders 把请求头改写成与 JS 层一致：
 *   Sec-CH-UA: "Not?A_Brand";v="99", "Chromium";v="130", "Google Chrome";v="130"
 *
 * 同时顺带修正 UA 中可能残留的 Electron 标识（防御性）。
 */

const CHROME_MAJOR = '130';
const CHROME_FULL = '130.0.0.0';

/** 构造标准的 Chrome 品牌头值 */
function buildBrandList(full) {
  const v = full ? CHROME_FULL : CHROME_MAJOR;
  return '"Not?A_Brand";v="99", "Chromium";v="' + v + '", "Google Chrome";v="' + v + '"';
}

/**
 * 由指纹 os 推导 Client Hints 平台信息（必须与 preload/fingerprint.js 的
 * navigator.userAgentData.platform 及 buildChromeUserAgent 的 UA 保持自洽）。
 * 任一不一致都会被检测方通过「JS 读数 vs 请求头」对比发现。
 * @param {string} os 'mac' | 'linux' | 其他（默认 windows）
 * @returns {{platform:string, platformVersion:string, arch:string, bitness:string, model:string}}
 */
function buildPlatformHints(os) {
  if (os === 'mac') {
    return { platform: 'macOS', platformVersion: '10.15.7', arch: 'x86', bitness: '64', model: '' };
  }
  if (os === 'linux') {
    return { platform: 'Linux', platformVersion: '0.0.0', arch: 'x86', bitness: '64', model: '' };
  }
  // 默认 / win
  return { platform: 'Windows', platformVersion: '10.0.0', arch: 'x86', bitness: '64', model: '' };
}

const applied = new WeakSet();

/**
 * 对指定 session 应用请求头修正（幂等）
 * @param {Electron.Session} ses
 * @param {object} [opts] 可选，{ language: 'en-US', os: 'win'|'mac'|'linux' }
 *   - language 用于对齐 Accept-Language
 *   - os 用于对齐 Sec-CH-UA-Platform 等 Client Hints 平台提示头
 */
function applyHeaderFix(ses, opts) {
  if (!ses || applied.has(ses)) return;
  applied.add(ses);
  const lang = (opts && opts.language) || '';
  const hints = buildPlatformHints(opts && opts.os);
  try {
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders || {};
      // 逐个大小写查找并改写（HTTP 头名大小写不敏感）
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (lower === 'sec-ch-ua') {
          headers[key] = buildBrandList(false);
        } else if (lower === 'sec-ch-ua-full-version-list') {
          headers[key] = buildBrandList(true);
        } else if (lower === 'sec-ch-ua-platform') {
          // 关键：JS 层 navigator.userAgentData.platform 已改成 Windows/macOS/Linux，
          // 若请求头仍为 Electron 原生值，二者矛盾即被判定为机器人。
          headers[key] = '"' + hints.platform + '"';
        } else if (lower === 'sec-ch-ua-platform-version') {
          headers[key] = '"' + hints.platformVersion + '"';
        } else if (lower === 'sec-ch-ua-arch') {
          headers[key] = '"' + hints.arch + '"';
        } else if (lower === 'sec-ch-ua-bitness') {
          headers[key] = '"' + hints.bitness + '"';
        } else if (lower === 'sec-ch-ua-model') {
          headers[key] = '""';
        } else if (lower === 'accept-language' && lang) {
          // 与指纹语言对齐：主语言 + 次语言 + 兜底
          const base = lang.split('-')[0];
          headers[key] = lang + ',' + base + ';q=0.9,en;q=0.8';
        }
      }
      callback({ requestHeaders: headers });
    });
    console.log('[TokFree Compat] 请求头修正已应用 (Sec-CH-UA → Google Chrome, Platform → ' + hints.platform + (lang ? ', Accept-Language → ' + lang : '') + ')');
  } catch (err) {
    console.error('[TokFree Compat] 请求头修正失败:', err && err.message);
  }
}

module.exports = { applyHeaderFix, buildBrandList, buildPlatformHints };
