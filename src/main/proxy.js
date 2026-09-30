/**
 * 代理管理（每个窗口独立，绑定到各自的 session partition）
 *
 * Electron 的 session.setProxy 支持：
 *   - direct：直连
 *   - fixed_servers：固定代理（http/https/socks5）
 *   - pac_script：PAC 脚本
 *
 * 代理认证：proxyRules 支持 http://user:pass@host:port 格式。
 */
const { session } = require('electron');

/** 把 profile.proxy 转成 Electron setProxy 的配置对象 */
function buildProxyConfig(proxy) {
  const p = proxy || {};
  if (!p.enabled || p.mode === 'direct' || !p.host) {
    return { mode: 'direct' };
  }
  if (p.mode === 'pac_script' && p.pacUrl) {
    return { mode: 'pac_script', pacScript: p.pacUrl };
  }
  const proto = (p.protocol || 'http').toLowerCase();
  const auth = p.username
    ? (encodeURIComponent(p.username) + (p.password ? ':' + encodeURIComponent(p.password) : '') + '@')
    : '';
  const hostPort = auth + p.host + ':' + (p.port || 0);
  let rules;
  if (proto === 'socks5' || proto === 'socks') {
    // SOCKS5：所有协议走 socks5
    rules = 'socks5://' + hostPort;
  } else {
    // http / https：http= 与 https= 各一条（值用 host:port，Chromium 标准语法）
    rules = 'http=' + hostPort + ';https=' + hostPort;
  }
  return {
    mode: 'fixed_servers',
    proxyRules: rules,
    proxyBypassRules: p.bypass || '<-loopback>',
  };
}

/**
 * 对指定 session 应用代理配置
 * @param {Electron.Session} ses session 对象
 * @param {object} proxy profile.proxy
 */
async function applyProxy(ses, proxy) {
  if (!ses) return { success: false, error: 'session 不存在' };
  try {
    const cfg = buildProxyConfig(proxy);
    await ses.setProxy(cfg);
    console.log('[Proxy] 已应用:', JSON.stringify(cfg));
    return { success: true, config: cfg };
  } catch (err) {
    console.error('[Proxy] 应用失败:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 测试代理连通性（用该 session 发起一次轻量请求）
 * @param {Electron.Session} ses session 对象
 * @param {object} proxy profile.proxy
 * @param {number} timeoutMs 超时
 */
async function testProxy(ses, proxy, timeoutMs) {
  if (!ses) return { success: false, error: 'session 不存在' };
  const to = timeoutMs || 8000;
  // 先应用配置（测试后调用方决定是否保留）
  await applyProxy(ses, proxy);
  try {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), to);
    // ses.fetch 可能不存在，回退到 net.fetch（Electron 内置）
    let fetchFn = ses.fetch ? ses.fetch.bind(ses) : null;
    if (!fetchFn) {
      try { fetchFn = require('electron').net.fetch; } catch (_) {}
    }
    if (!fetchFn) {
      clearTimeout(timer);
      return { success: false, error: '当前 Electron 不支持 fetch，无法测试' };
    }
    const res = await fetchFn('https://api.ipify.org?format=json', { signal: controller.signal });
    clearTimeout(timer);
    const text = await res.text();
    let ip = '';
    try { ip = JSON.parse(text).ip; } catch (_) { ip = text.trim(); }
    const ms = Date.now() - started;
    return { success: true, ip, ms };
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? ('超时（>' + to + 'ms）') : (err.message || String(err));
    return { success: false, error: msg };
  }
}

module.exports = { buildProxyConfig, applyProxy, testProxy };
