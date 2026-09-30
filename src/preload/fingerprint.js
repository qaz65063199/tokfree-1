/**
 * 指纹伪装模块（preload 侧）
 *
 * 在主世界（页面脚本执行前）注入 JS，覆盖 navigator / screen / WebGL /
 * Canvas / Audio / WebRTC 等指纹面，使每个窗口呈现稳定且独立的浏览器身份。
 *
 * 设计：
 * - 由 profile.fingerprint.seed 决定身份，同 seed 重启后保持一致
 * - 通过主进程 additionalArguments 传入配置（base64），preload 读取后注入
 * - 不改 User-Agent / sec-ch-ua（由主进程 setUserAgent 统一控制，避免不一致）
 */

/** 从 process.argv 读取指纹配置 */
function readFingerprintConfig() {
  try {
    const PREFIX = '--tokfree-fingerprint=';
    for (const arg of process.argv) {
      if (typeof arg === 'string' && arg.startsWith(PREFIX)) {
        const b64 = arg.slice(PREFIX.length);
        const json = Buffer.from(b64, 'base64').toString('utf8');
        return JSON.parse(json);
      }
    }
  } catch (err) {
    console.error('[TokFree FP] 读取配置失败:', err && err.message);
  }
  return null;
}

/** 主世界执行的指纹伪装函数体（字符串形式，避免被隔离世界包装） */
function fingerprintFn(cfg) {
  if (!cfg || !cfg.enabled) return;
  try {
    // 幂等：CDP 与 preload 可能都注入，只应用一次。用 Symbol 降低被检测概率
    var FP_MARKER = Symbol.for('tokfree.fp');
    if (window[FP_MARKER]) return;
    try { Object.defineProperty(window, FP_MARKER, { value: 1, configurable: true }); } catch (e) {}
    var seed = cfg.seed || 12345;
    function mulberry32(a) {
      return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        var t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }
    var rng = mulberry32(seed);
    function defGet(obj, prop, getter) {
      try { Object.defineProperty(obj, prop, { get: getter, configurable: true }); } catch (e) {}
    }

    var isMac = cfg.os === 'mac';
    var isLinux = cfg.os === 'linux';
    var platform = isMac ? 'MacIntel' : (isLinux ? 'Linux x86_64' : 'Win32');

    // ===== navigator =====
    var nav = window.navigator;
    defGet(nav, 'platform', function () { return platform; });
    // userAgentData.platform 必须与 navigator.platform 一致，否则自相矛盾
    try {
      if (nav.userAgentData) {
        var uaPlatform = isMac ? 'macOS' : (isLinux ? 'Linux' : 'Windows');
        var uaPlatformVer = isMac ? '10.15.7' : (isLinux ? '0.0.0' : '10.0.0');
        Object.defineProperty(nav.userAgentData, 'platform', { get: function () { return uaPlatform; }, configurable: true });
        // 关键：getHighEntropyValues() 返回的是 C++ 原生数据，不受上面的 defineProperty 影响。
        // 若只改 platform getter 而漏了它，检测方调 getHighEntropyValues(['platform'])
        // 会拿到 Electron 原生值，与 getter 读数矛盾 → 判定机器人。
        // 这里把 platform/platformVersion/architecture/bitness/model 一并覆盖，且与请求头
        // (Sec-CH-UA-Platform 等) 及 UA 三者保持自洽。
        var origGetHEV = nav.userAgentData.getHighEntropyValues;
        if (typeof origGetHEV === 'function') {
          var patchedHEV = function (hints) {
            return origGetHEV.call(this, hints).then(function (v) {
              try {
                v.platform = uaPlatform;
                v.platformVersion = uaPlatformVer;
                v.architecture = 'x86';
                v.bitness = '64';
                v.model = '';
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
    } catch (e) {}
    defGet(nav, 'hardwareConcurrency', function () { return cfg.hardwareConcurrency || 8; });
    defGet(nav, 'deviceMemory', function () { return cfg.deviceMemory || 8; });
    defGet(nav, 'webdriver', function () { return false; });
    if (cfg.language) {
      defGet(nav, 'language', function () { return cfg.language; });
      defGet(nav, 'languages', function () { return [cfg.language, cfg.language.split('-')[0]]; });
    }
    // plugins / mimeTypes（模仿 Chrome）
    defGet(nav, 'plugins', function () {
      var arr = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
      ];
      arr.item = function (i) { return this[i]; };
      arr.namedItem = function (n) { for (var i = 0; i < this.length; i++) if (this[i].name === n) return this[i]; return null; };
      return arr;
    });
    defGet(nav, 'mimeTypes', function () {
      var arr = [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' }
      ];
      arr.item = function (i) { return this[i]; };
      arr.namedItem = function (n) { for (var i = 0; i < this.length; i++) if (this[i].type === n) return this[i]; return null; };
      return arr;
    });

    // ===== screen =====
    if (cfg.screenWidth) defGet(screen, 'width', function () { return cfg.screenWidth; });
    if (cfg.screenHeight) defGet(screen, 'height', function () { return cfg.screenHeight; });
    if (cfg.screenWidth) defGet(screen, 'availWidth', function () { return cfg.screenWidth; });
    if (cfg.screenHeight) defGet(screen, 'availHeight', function () { return cfg.screenHeight - 40; });

    // ===== 时区（Intl）=====
    if (cfg.timezone) {
      try {
        var OrigDTF = Intl.DateTimeFormat;
        var tz = cfg.timezone;
        // 计算该时区真实偏移（分钟；getTimezoneOffset 语义 = UTC - 本地）
        var tzOffset = (function (zone) {
          try {
            var d = new Date();
            var utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
            var loc = new Date(d.toLocaleString('en-US', { timeZone: zone }));
            return Math.round((utc - loc) / 60000);
          } catch (e) { return undefined; }
        })(tz);
        var patched = function (locale, options) {
          options = options || {};
          if (!options.timeZone) options.timeZone = tz;
          return new OrigDTF(locale, options);
        };
        patched.prototype = OrigDTF.prototype;
        patched.supportedLocalesOf = OrigDTF.supportedLocalesOf;
        Intl.DateTimeFormat = patched;
        // resolvedOptions().timeZone 兜底：未显式指定时区时强制回填 cfg 时区
        try {
          var origResolved = OrigDTF.prototype.resolvedOptions;
          Object.defineProperty(OrigDTF.prototype, 'resolvedOptions', {
            value: function () {
              var r = origResolved.call(this);
              try { if (!r.timeZone) r.timeZone = tz; } catch (e) {}
              return r;
            },
            writable: true, configurable: true,
          });
        } catch (e) {}
        // Date.prototype.getTimezoneOffset 同步为时区对应值
        if (tzOffset !== undefined) {
          Date.prototype.getTimezoneOffset = function () { return tzOffset; };
        } else {
          var tzOffsetMap = { 'Asia/Shanghai': -480, 'America/New_York': 300, 'Europe/London': 0, 'Asia/Tokyo': -540, 'Europe/Berlin': -60 };
          if (tzOffsetMap[tz] !== undefined) {
            var off = tzOffsetMap[tz];
            Date.prototype.getTimezoneOffset = function () { return off; };
          }
        }
      } catch (e) {}
    }

    // ===== WebGL vendor/renderer =====
    try {
      var VENDOR = 37445, RENDERER = 37446;
      var vendorStr = cfg.webglVendor || 'Google Inc. (Intel)';
      var rendererStr = cfg.webglRenderer || 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
      if (window.WebGLRenderingContext) {
        var gp1 = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (p) {
          if (p === VENDOR) return vendorStr;
          if (p === RENDERER) return rendererStr;
          return gp1.apply(this, arguments);
        };
      }
      if (window.WebGL2RenderingContext) {
        var gp2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function (p) {
          if (p === VENDOR) return vendorStr;
          if (p === RENDERER) return rendererStr;
          return gp2.apply(this, arguments);
        };
      }
    } catch (e) {}

    // ===== Canvas 噪声（确定性）=====
    // 关键：噪声必须"确定性"——同一 canvas 每次读取结果一致，否则
    // 「同一 canvas 两次哈希不同」本身就是极强的自动化特征。
    // 之前用 rng()（每次调用产生新值）导致不稳定；且 toDataURL 走真实像素、
    // getImageData 走噪声，两者不一致更是铁证。此处统一为基于像素坐标+seed 的确定性噪声。
    try {
      var origGID = CanvasRenderingContext2D.prototype.getImageData;
      var origToDataURL = HTMLCanvasElement.prototype.toDataURL;

      // 确定性噪声：-1 / 0 / +1
      var canvasNoise = function (px, py) {
        var h = (px * 374761393 + py * 668265263 + seed) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        h = (h ^ (h >>> 16)) >>> 0;
        return (h % 3) - 1;
      };
      var applyCanvasNoise = function (d, w) {
        if (!w) w = 1;
        for (var i = 0; i < d.length; i += 4 * 97) {
          var idx = i / 4;
          var px = idx % w;
          var py = (idx / w) | 0;
          var n = canvasNoise(px, py);
          if (n) {
            d[i] = Math.max(0, Math.min(255, d[i] + n));
            d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
            d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
          }
        }
      };

      CanvasRenderingContext2D.prototype.getImageData = function () {
        var data = origGID.apply(this, arguments);
        try { applyCanvasNoise(data.data, data.width || 1); } catch (e) {}
        return data;
      };

      // toDataURL 与 getImageData 必须一致：临时加噪→取图→恢复
      HTMLCanvasElement.prototype.toDataURL = function () {
        try {
          var ctx = this.getContext && this.getContext('2d');
          if (ctx && this.width > 0 && this.height > 0) {
            var snapshot = origGID.call(ctx, 0, 0, this.width, this.height);
            var noisy = ctx.createImageData(this.width, this.height);
            noisy.data.set(snapshot.data);
            applyCanvasNoise(noisy.data, this.width);
            ctx.putImageData(noisy, 0, 0);
            var result = origToDataURL.apply(this, arguments);
            ctx.putImageData(snapshot, 0, 0); // 恢复原始像素
            return result;
          }
        } catch (e) {}
        return origToDataURL.apply(this, arguments);
      };
    } catch (e) {}

    // ===== Audio 噪声（确定性）=====
    try {
      if (window.AudioBuffer) {
        var origGCD = AudioBuffer.prototype.getChannelData;
        var audioNoise = function (i) {
          var h = (i * 2654435761 + seed) | 0;
          h = (h ^ (h >>> 15)) >>> 0;
          return (h / 4294967296) - 0.5;
        };
        AudioBuffer.prototype.getChannelData = function () {
          var data = origGCD.apply(this, arguments);
          try {
            for (var i = 0; i < data.length; i += 1000) {
              data[i] = data[i] + audioNoise(i) * 1e-7;
            }
          } catch (e) {}
          return data;
        };
      }
    } catch (e) {}

    // ===== WebRTC 防泄漏 =====
    try {
      if (window.RTCPeerConnection) {
        var OrigRTC = window.RTCPeerConnection;
        var Patched = function (config, constraints) {
          if (config && config.iceServers) config.iceServers = [];
          return new OrigRTC(config, constraints);
        };
        Patched.prototype = OrigRTC.prototype;
        window.RTCPeerConnection = Patched;
      }
    } catch (e) {}

    // ===== Fonts（本地字体枚举，按 seed 生成确定性列表）=====
    // Chrome 的 Local Font Access API（queryLocalFonts）是字体指纹的主要入口；
    // 返回一份基于 seed 的确定性字体列表，同 seed 稳定、跨 seed 不同。
    try {
      var FONT_POOL = ['Arial', 'Calibri', 'Cambria', 'Consolas', 'Courier New', 'Georgia', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Microsoft YaHei', 'SimSun', 'Microsoft JhengHei'];
      var fonts = FONT_POOL.filter(function (_, i) { return (Math.floor(rng() * 100) + i) % 3 !== 0; });
      if (!fonts.length) fonts = ['Arial', 'Segoe UI'];
      var origQLF = nav.queryLocalFonts;
      var patchedQLF = function () {
        return Promise.resolve(fonts.map(function (f) {
          return { family: f, fullName: f, postscriptName: f.replace(/\s+/g, ''), style: 'Regular' };
        }));
      };
      try {
        Object.defineProperty(nav, 'queryLocalFonts', { value: patchedQLF, writable: true, configurable: true });
      } catch (e) {}
      // document.fonts.check 对已知字体返回 true（进一步自洽）
      try {
        if (document.fonts && typeof document.fonts.check === 'function') {
          var origCheck = document.fonts.check.bind(document.fonts);
          document.fonts.check = function (font, text) {
            try {
              if (font && /\b(Arial|Segoe UI|Calibri|Verdana|Georgia)\b/i.test(font)) return true;
            } catch (e) {}
            return origCheck(font, text);
          };
        }
      } catch (e) {}
      void origQLF;
    } catch (e) {}

    // ===== WebGPU（navigator.gpu.requestAdapter 伪 adapter）=====
    // 无 WebGPU 是部分新检测站的机器人信号；给出确定性 adapter，且 vendor/arch 与 WebGL 自洽。
    try {
      if (nav.gpu && typeof nav.gpu.requestAdapter === 'function') {
        var origReqAdapter = nav.gpu.requestAdapter.bind(nav.gpu);
        var fpVendor = cfg.webglVendor || 'Google Inc. (Intel)';
        var isIntel = /Intel/i.test(fpVendor);
        var isNvidia = /NVIDIA/i.test(fpVendor);
        var isAmd = /AMD|Radeon/i.test(fpVendor);
        var gpuVendor = isIntel ? 'intel' : (isNvidia ? 'nvidia' : (isAmd ? 'amd' : 'intel'));
        var gpuArch = isIntel ? 'gen-12lp' : (isNvidia ? 'ampere' : (isAmd ? 'rdna-2' : 'gen-12lp'));
        nav.gpu.requestAdapter = function () {
          return origReqAdapter.apply(null, arguments).then(function (adapter) {
            if (!adapter) {
              // 原生无 adapter 时也返回一个最小伪对象，避免暴露"无 WebGPU"
              return {
                requestDevice: function () { return Promise.resolve({}); },
                features: new Set(),
                limits: {},
                info: { vendor: gpuVendor, architecture: gpuArch, device: '', description: '' },
                __tokfree: true,
              };
            }
            try {
              Object.defineProperty(adapter, 'info', {
                get: function () { return { vendor: gpuVendor, architecture: gpuArch, device: '', description: '' }; },
                configurable: true,
              });
            } catch (e) {}
            return adapter;
          });
        };
      }
    } catch (e) {}

    // ===== 信号自洽自检（仅 dev 诊断，不阻断）=====
    // 检查 UA / platform / userAgentData / screen / timezone 是否互相矛盾，
    // 不一致时 console.warn（便于排查，不影响页面）。
    try {
      var selfCheck = function () {
        var warns = [];
        var ua = nav.userAgent || '';
        var plat = '';
        try { plat = nav.platform || ''; } catch (e) {}
        // UA vs platform
        var uaIsWin = /Windows/.test(ua);
        var uaIsMac = /Macintosh/.test(ua);
        var uaIsLinux = /Linux/.test(ua);
        if (uaIsWin && plat && !/Win/.test(plat)) warns.push('UA=Windows 但 platform=' + plat);
        if (uaIsMac && plat && !/Mac/.test(plat)) warns.push('UA=macOS 但 platform=' + plat);
        if (uaIsLinux && plat && !/Linux/.test(plat)) warns.push('UA=Linux 但 platform=' + plat);
        // userAgentData.platform vs UA
        try {
          if (nav.userAgentData && nav.userAgentData.platform) {
            var uap = nav.userAgentData.platform;
            if (uaIsWin && uap !== 'Windows') warns.push('UA=Windows 但 userAgentData.platform=' + uap);
            if (uaIsMac && uap !== 'macOS') warns.push('UA=macOS 但 userAgentData.platform=' + uap);
            if (uaIsLinux && uap !== 'Linux') warns.push('UA=Linux 但 userAgentData.platform=' + uap);
          }
        } catch (e) {}
        // screen 尺寸合理性
        try {
          if (screen.width > screen.height) warns.push('screen 宽>高（疑似横屏伪造）');
        } catch (e) {}
        if (warns.length) console.warn('[TokFree FP] 信号不自洽: ' + warns.join(' | '));
        return warns;
      };
      window.__tokfreeFpSelfCheck = selfCheck;
    } catch (e) {}

    // ===== Worker 伪装 =====
    // 关键：Worker 里的 navigator 是独立环境，主线程的 defineProperty 改不到它。
    // 拦截 Blob：当网页用 Blob 创建 JS Worker 时，在脚本前插入身份覆盖代码。
    // （多数现代站点用 blob worker；URL worker 受跨域限制无法改写内容）
    try {
      var langBase = cfg.language ? cfg.language.split('-')[0] : '';
      var shim = 'try{var _n=self.navigator;' +
        'try{Object.defineProperty(_n,"platform",{get:function(){return ' + JSON.stringify(platform) + ';},configurable:true});}catch(e){}' +
        'try{Object.defineProperty(_n,"hardwareConcurrency",{get:function(){return ' + (cfg.hardwareConcurrency || 8) + ';},configurable:true});}catch(e){}' +
        'try{Object.defineProperty(_n,"deviceMemory",{get:function(){return ' + (cfg.deviceMemory || 8) + ';},configurable:true});}catch(e){}' +
        'try{Object.defineProperty(_n,"webdriver",{get:function(){return false;},configurable:true});}catch(e){}' +
        (cfg.language ? 'try{Object.defineProperty(_n,"language",{get:function(){return ' + JSON.stringify(cfg.language) + ';},configurable:true});}catch(e){}' +
          'try{Object.defineProperty(_n,"languages",{get:function(){return [' + JSON.stringify(cfg.language) + ',' + JSON.stringify(langBase) + '];},configurable:true});}catch(e){}' : '') +
        '}catch(e){};';
      var OrigBlob = window.Blob;
      var PatchedBlob = function (parts, options) {
        try {
          var opts = options || {};
          if (/javascript/i.test(opts.type || '') && Array.isArray(parts)) {
            return new OrigBlob([shim].concat(parts), options);
          }
        } catch (e) {}
        return new OrigBlob(parts, options);
      };
      PatchedBlob.prototype = OrigBlob.prototype;
      Object.defineProperty(window, 'Blob', { value: PatchedBlob, writable: true, configurable: true });
    } catch (e) {}

    console.log('[TokFree FP] 指纹伪装已应用 seed=' + seed);
  } catch (err) {
    console.error('[TokFree FP] 应用失败:', err && err.message);
  }
}

/** 构造注入主世界的源码字符串 */
function buildFingerprintScript(cfg) {
  return '(' + fingerprintFn.toString() + ')(' + JSON.stringify(cfg) + ');';
}

module.exports = { readFingerprintConfig, buildFingerprintScript };
