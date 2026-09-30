/**
 * 浏览器兼容 / 反自动化特征修复（常驻，所有窗口生效）
 *
 * Electron 默认会暴露若干可被检测的特征，导致 Google 登录、Cloudflare 等
 * 判定"环境不安全"或触发机器人验证。本模块在主世界注入，修复以下特征：
 *
 * 1. window.chrome —— Electron 默认为空对象（真实 Chrome 有 runtime/csi/loadTimes/app）
 * 2. navigator.userAgentData.brands —— 补上 "Google Chrome" 品牌
 * 3. navigator.webdriver —— 确保为 false
 * 4. navigator.plugins / mimeTypes —— 补齐 PDF 插件（Electron 常为空）
 * 5. navigator.permissions.query —— 修正 notification 权限回显
 *
 * 注意：这是"基础兼容"，与 profile.fingerprint（按窗口的随机身份）相互独立。
 * 由 preload 在页面脚本执行前注入主世界。
 */

/** 主世界执行体 */
function browserCompatFn() {
  try {
    // 幂等标记用 Symbol：不出现在 Object.keys()/for...in 中，降低被反检测扫描的概率
    var MARKER = Symbol.for('tokfree.compat');
    if (window[MARKER]) return;
    try { Object.defineProperty(window, MARKER, { value: 1, configurable: true }); } catch (e) {}

    var nav = window.navigator;

    // ===== 1. window.chrome =====
    try {
      var chrome = window.chrome || {};
      // runtime：真实 Chrome 必有（即使是空对象也有这些方法）
      if (!chrome.runtime) chrome.runtime = {};
      if (typeof chrome.runtime.connect !== 'function') {
        chrome.runtime.connect = function () { throw new Error('Could not establish connection. Receiving end does not exist.'); };
      }
      if (typeof chrome.runtime.sendMessage !== 'function') {
        chrome.runtime.sendMessage = function () { throw new Error('Could not establish connection. Receiving end does not exist.'); };
      }
      if (typeof chrome.runtime.id === 'undefined') chrome.runtime.id = undefined;
      // app
      if (!chrome.app) {
        chrome.app = {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
          getDetails: function () { return null; },
          getIsInstalled: function () { return false; },
        };
      }
      // csi / loadTimes（真实 Chrome 有，返回导航时序对象）
      if (typeof chrome.csi !== 'function') {
        chrome.csi = function () {
          var t = Date.now() / 1000;
          return { onloadT: t, startE: t - 1, pageT: 1000, tran: 15 };
        };
      }
      if (typeof chrome.loadTimes !== 'function') {
        chrome.loadTimes = function () {
          var t = Date.now() / 1000;
          return {
            commitLoadTime: t - 0.5, connectionInfo: 'h2',
            finishDocumentLoadTime: t - 0.2, finishLoadTime: t - 0.1,
            firstPaintTime: t - 0.3, firstPaintAfterLoadTime: 0,
            navigationType: 'Other', npnNegotiatedProtocol: 'h2',
            requestTime: t - 1, startLoadTime: t - 0.9,
            wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true,
          };
        };
      }
      window.chrome = chrome;
    } catch (e) {}

    // ===== 2. userAgentData.brands 补 Google Chrome =====
    try {
      if (nav.userAgentData && Array.isArray(nav.userAgentData.brands)) {
        var brands = nav.userAgentData.brands;
        var hasGoogle = brands.some(function (b) { return b.brand === 'Google Chrome'; });
        if (!hasGoogle) {
          // 取 Chromium 主版本号，构造与真实 Chrome 一致的品牌列表
          var major = '130';
          for (var i = 0; i < brands.length; i++) {
            if (brands[i].brand === 'Chromium') { major = brands[i].version; break; }
          }
          var newBrands = [
            { brand: 'Google Chrome', version: major },
            { brand: 'Chromium', version: major },
            { brand: 'Not?A_Brand', version: '99' },
          ];
          Object.defineProperty(nav.userAgentData, 'brands', { get: function () { return newBrands; }, configurable: true });

          // 关键：getHighEntropyValues() 返回的是 C++ 原生数据，不受上面的 defineProperty 影响。
          // 必须一并包装，否则检测方调它就能看到「无 Google Chrome」的矛盾。
          var origGetHEV = nav.userAgentData.getHighEntropyValues;
          if (typeof origGetHEV === 'function') {
            var newFullList = [
              { brand: 'Google Chrome', version: major + '.0.0.0' },
              { brand: 'Chromium', version: major + '.0.0.0' },
              { brand: 'Not?A_Brand', version: '99.0.0.0' },
            ];
            var patchedHEV = function (hints) {
              return origGetHEV.call(this, hints).then(function (v) {
                try {
                  v.brands = newBrands;
                  if (v.fullVersionList) v.fullVersionList = newFullList;
                  // 兜底：指纹模块未启用时，platform 仍是 Electron 原生值，
                  // 与请求头 Sec-CH-UA-Platform（默认 Windows）矛盾。这里补默认 Windows。
                  // （指纹启用时由 fingerprint.js 覆盖为对应 os，二者不冲突。）
                  if (!v.platform) v.platform = 'Windows';
                  if (!v.platformVersion) v.platformVersion = '10.0.0';
                  if (v.architecture === undefined) v.architecture = 'x86';
                  if (v.bitness === undefined) v.bitness = '64';
                } catch (e) {}
                return v;
              });
            };
            try {
              Object.defineProperty(nav.userAgentData, 'getHighEntropyValues', {
                value: patchedHEV, writable: true, configurable: true,
              });
            } catch (e) {}
          }
        }
      }
    } catch (e) {}

    // ===== 3. navigator.webdriver =====
    try {
      if (nav.webdriver !== false) {
        Object.defineProperty(nav, 'webdriver', { get: function () { return false; }, configurable: true });
      }
    } catch (e) {}

    // ===== 4. plugins / mimeTypes（Electron 常为空，补 PDF 插件）=====
    try {
      if (!nav.plugins || nav.plugins.length === 0) {
        var pluginArr = [
          { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 2 },
          { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 2 },
          { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 2 },
          { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 2 },
          { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 2 },
        ];
        var mimeArr = [
          { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
          { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        ];
        pluginArr.item = function (i) { return this[i] || null; };
        pluginArr.namedItem = function (n) { for (var i = 0; i < this.length; i++) if (this[i].name === n) return this[i]; return null; };
        pluginArr.refresh = function () {};
        mimeArr.item = function (i) { return this[i] || null; };
        mimeArr.namedItem = function (n) { for (var i = 0; i < this.length; i++) if (this[i].type === n) return this[i]; return null; };
        Object.defineProperty(nav, 'plugins', { get: function () { return pluginArr; }, configurable: true });
        Object.defineProperty(nav, 'mimeTypes', { get: function () { return mimeArr; }, configurable: true });
      }
    } catch (e) {}

    // ===== 5. 隐藏注入痕迹：Function.prototype.toString 对补丁函数返回原生码 =====
    try {
      var nativeToString = Function.prototype.toString;
      var patched = new WeakMap();
      Function.prototype.toString = function () {
        if (patched.has(this)) return patched.get(this);
        return nativeToString.call(this);
      };
      // 标记常见的 getter 为"原生"
      var markNative = function (fn) {
        try { patched.set(fn, 'function () { [native code] }'); } catch (e) {}
        return fn;
      };
      // 不暴露到 window（避免成为可扫描的非常规全局变量）
      // 把改写过 navigator 的关键 getter 标记为原生
      try {
        var wd = Object.getOwnPropertyDescriptor(navigator, 'webdriver');
        if (wd && wd.get) markNative(wd.get);
      } catch (e) {}
    } catch (e) {}

    // ===== 5b. Worker 基础伪装 =====
    // Worker 里的 navigator 是独立环境；拦截 Blob 给 JS Worker 前置 webdriver=false 等。
    try {
      var workerShim = 'try{var _n=self.navigator;' +
        'try{Object.defineProperty(_n,"webdriver",{get:function(){return false;},configurable:true});}catch(e){}' +
        '}catch(e){};';
      var OrigBlob2 = window.Blob;
      var PatchedBlob2 = function (parts, options) {
        try {
          var opts = options || {};
          if (/javascript/i.test(opts.type || '') && Array.isArray(parts)) {
            return new OrigBlob2([workerShim].concat(parts), options);
          }
        } catch (e) {}
        return new OrigBlob2(parts, options);
      };
      PatchedBlob2.prototype = OrigBlob2.prototype;
      Object.defineProperty(window, 'Blob', { value: PatchedBlob2, writable: true, configurable: true });
    } catch (e) {}

    // ===== 6. 权限修正 =====
    // Electron 默认权限为 'granted'，但真实 Chrome 首次访问是 'default'/'prompt'，
    // 这是 sannysoft 等检测站的明显破绽。
    // 关键：检测站查的是 navigator.permissions.query({name:'notifications'}).state，
    //       同时也查 Notification.permission，两者都要修正且保持一致。
    try {
      var permGranted = { notifications: false, geolocation: false, camera: false, microphone: false };

      // 6a. 包装 Notification.requestPermission，记录用户真实授权
      if (typeof Notification !== 'undefined') {
        var origNotifReq = Notification.requestPermission;
        if (typeof origNotifReq === 'function') {
          var patchedReq = function () {
            var p = origNotifReq.apply(this, arguments);
            if (p && typeof p.then === 'function') {
              p.then(function (r) { if (r === 'granted') permGranted.notifications = true; });
            }
            return p;
          };
          try { Object.defineProperty(Notification, 'permission', {
            get: function () { return permGranted.notifications ? 'granted' : 'default'; },
            configurable: true,
          }); } catch (e) {}
          Notification.requestPermission = patchedReq;
        }
      }

      // 6b. 包装 navigator.permissions.query
      if (nav.permissions && typeof nav.permissions.query === 'function') {
        var origQuery = nav.permissions.query.bind(nav.permissions);
        var patchedQuery = function (desc) {
          var name = desc && desc.name;
          return origQuery(desc).then(function (status) {
            // 未实际授权时，把 'granted' 伪装成 'prompt'
            if (name && permGranted[name] === false) {
              try {
                Object.defineProperty(status, 'state', {
                  get: function () { return 'prompt'; },
                  configurable: true,
                });
              } catch (e) {}
            }
            return status;
          });
        };
        nav.permissions.query = patchedQuery;
        // 标记为原生（toString 不可疑）
        try {
          var mk = Function.prototype.toString;
          var nativeMap = new WeakMap();
          nativeMap.set(patchedQuery, 'function query() { [native code] }');
          var curToString = Function.prototype.toString;
          Function.prototype.toString = function () {
            if (nativeMap.has(this)) return nativeMap.get(this);
            return curToString.call(this);
          };
        } catch (e) {}
      }
    } catch (e) {}

    console.log('[TokFree Compat] 浏览器兼容特征已修复');
  } catch (err) {
    console.error('[TokFree Compat] 应用失败:', err && err.message);
  }
}

/** 构造注入主世界的源码 */
function buildBrowserCompatScript() {
  return '(' + browserCompatFn.toString() + ')();';
}

module.exports = { buildBrowserCompatScript };
