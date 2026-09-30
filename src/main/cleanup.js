/**
 * 磁盘清理模块
 *
 * 职责：清理 TokFree 运行产生的垃圾文件，避免 userData 无限膨胀。
 *
 * 垃圾来源：
 *  1. 孤儿 partition 目录：删除 profile 后遗留的浏览器数据（几百 MB）
 *  2. 截图：screenshot() 生成的 PNG（默认保留最近 50 张 / 7 天）
 *  3. 日志：wyp/log/*.log（单文件超 5MB 截断）
 *  4. 孤立 session-dir-map：profile 已删但映射文件还在
 *
 * ⚠️ 关键区分（清理时绝不能碰登录态）：
 *  - 可安全删（纯缓存）：Cache / Code Cache / GPUCache / DawnWebGPUCache /
 *    DawnGraphiteCache / VideoDecodeStats / blob_storage / Shared Dictionary
 *  - 绝不能删（登录态）：Local Storage / IndexedDB / Cookies / Network /
 *    Session Storage / WebStorage / Local State
 *
 * 注意：清理在 app ready 后、窗口创建前执行（此时 partition 未被占用）；
 * 「立即清理缓存」入口需要用户先关闭对应窗口。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// ========== 常量 ==========
const SCREENSHOT_KEEP_MAX = 50;        // 截图最多保留张数
const SCREENSHOT_KEEP_DAYS = 7;        // 截图最多保留天数
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 单个日志文件上限 5MB
const CACHE_SUBDIRS = [                // 可安全删除的纯缓存子目录
  'Cache', 'Code Cache', 'GPUCache', 'DawnWebGPUCache', 'DawnGraphiteCache',
  'VideoDecodeStats', 'blob_storage', 'Shared Dictionary', 'shared_proto_db',
];

function getUserDataDir() {
  try { return app.getPath('userData'); } catch (_) { return null; }
}

/** 递归统计目录大小（字节）；失败返回 0 */
function dirSize(dir) {
  let total = 0;
  try {
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) { stack.push(full); }
        else if (e.isFile()) {
          try { total += fs.statSync(full).size; } catch (_) {}
        }
      }
    }
  } catch (_) {}
  return total;
}

/** 递归删除目录（尽力而为，跳过占用中的文件） */
function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    return true;
  } catch (_) {
    // 逐个删（处理个别文件被占用）
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) rmDir(full);
        else { try { fs.unlinkSync(full); } catch (_) {} }
      }
      try { fs.rmdirSync(dir); } catch (_) {}
    } catch (_) {}
    return false;
  }
}

/** 递归统计目录大小（异步版，避免阻塞主进程）；失败返回 0 */
async function dirSizeAsync(dir) {
  let total = 0;
  try {
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try { entries = await fs.promises.readdir(cur, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) { stack.push(full); }
        else if (e.isFile()) {
          try { total += (await fs.promises.stat(full)).size; } catch (_) {}
        }
      }
    }
  } catch (_) {}
  return total;
}

/** 递归删除目录（异步版，尽力而为，跳过占用中的文件）；返回是否成功 */
async function rmDirAsync(dir) {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 2 });
    return true;
  } catch (_) {
    // 逐个删（处理个别文件被占用）
    try {
      for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await rmDirAsync(full);
        else { try { await fs.promises.unlink(full); } catch (_) {} }
      }
      try { await fs.promises.rmdir(dir); } catch (_) {}
    } catch (_) {}
    return false;
  }
}

/** 读取现有 profile id 集合 */
function getLiveProfileIds() {
  const ids = new Set();
  try {
    const userData = getUserDataDir();
    const file = path.join(userData, 'profile-list.json');
    if (fs.existsSync(file)) {
      const list = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(list)) for (const p of list) { if (p && p.id) ids.add(p.id); }
    }
  } catch (_) {}
  return ids;
}

/** 从 partition 目录名提取 profileId（形如 'deepseek%3Aprofile-xxx' 或 'profile-xxx'） */
function extractProfileIdFromDirName(name) {
  try {
    const decoded = decodeURIComponent(name);
    const idx = decoded.lastIndexOf('profile-');
    return idx >= 0 ? decoded.slice(idx) : null;
  } catch (_) {
    const idx = name.lastIndexOf('profile-');
    return idx >= 0 ? name.slice(idx) : null;
  }
}

/**
 * 清理孤儿 partition 目录（profile 已删但目录还在）
 * @returns {{ removed: string[], count: number, freedBytes: number }}
 */
function cleanupOrphanPartitions() {
  const userData = getUserDataDir();
  if (!userData) return { removed: [], count: 0, freedBytes: 0 };
  const partitionsDir = path.join(userData, 'Partitions');
  if (!fs.existsSync(partitionsDir)) return { removed: [], count: 0, freedBytes: 0 };

  const liveIds = getLiveProfileIds();
  const removed = [];
  let freed = 0;

  let entries;
  try { entries = fs.readdirSync(partitionsDir, { withFileTypes: true }); } catch (_) { return { removed: [], count: 0, freedBytes: 0 }; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const pid = extractProfileIdFromDirName(e.name);
    // pid 为 null（无法识别）或 不在现有 profile 里 → 孤儿，删
    if (pid && liveIds.has(pid)) continue;
    const full = path.join(partitionsDir, e.name);
    const size = dirSize(full);
    if (rmDir(full)) { removed.push(e.name); freed += size; }
  }
  return { removed, count: removed.length, freedBytes: freed };
}

/**
 * 清理旧截图（保留最近 N 张 / M 天）
 * @returns {{ removed: number, freedBytes: number }}
 */
function cleanupOldScreenshots() {
  const userData = getUserDataDir();
  if (!userData) return { removed: 0, freedBytes: 0 };
  const dir = path.join(userData, 'screenshots');
  if (!fs.existsSync(dir)) return { removed: 0, freedBytes: 0 };

  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.png')).map(f => {
      const full = path.join(dir, f);
      let mtime = 0, size = 0;
      try { const st = fs.statSync(full); mtime = st.mtimeMs; size = st.size; } catch (_) {}
      return { full, name: f, mtime, size };
    });
  } catch (_) { return { removed: 0, freedBytes: 0 }; }

  // 按修改时间倒序（新的在前）
  files.sort((a, b) => b.mtime - a.mtime);
  const cutoff = Date.now() - SCREENSHOT_KEEP_DAYS * 86400 * 1000;
  let removed = 0, freed = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    // 超出张数上限 或 超过保留天数 → 删
    if (i >= SCREENSHOT_KEEP_MAX || f.mtime < cutoff) {
      try { fs.unlinkSync(f.full); removed++; freed += f.size; } catch (_) {}
    }
  }
  return { removed, freedBytes: freed };
}

/** 截断超大日志文件 */
function cleanupLogs() {
  const userData = getUserDataDir();
  if (!userData) return { truncated: 0, freedBytes: 0 };
  const dir = path.join(userData, 'wyp', 'log');
  if (!fs.existsSync(dir)) return { truncated: 0, freedBytes: 0 };
  let truncated = 0, freed = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.log')) continue;
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (st.size > LOG_MAX_BYTES) {
          // 保留尾部 1MB
          const buf = fs.readFileSync(full);
          const tail = buf.slice(buf.length - 1024 * 1024);
          fs.writeFileSync(full, tail);
          truncated++; freed += (st.size - tail.length);
        }
      } catch (_) {}
    }
  } catch (_) {}
  return { truncated, freedBytes: freed };
}

/** 清理孤立 session-dir-map（profile 已删） */
function cleanupOrphanSessionMaps() {
  const userData = getUserDataDir();
  if (!userData) return { removed: 0, freedBytes: 0 };
  const liveIds = getLiveProfileIds();
  let removed = 0, freed = 0;
  try {
    for (const f of fs.readdirSync(userData)) {
      const m = f.match(/^session-dir-map-(.+).json$/);
      if (!m) continue;
      const pid = m[1];
      if (liveIds.has(pid)) continue;
      const full = path.join(userData, f);
      try { const st = fs.statSync(full); fs.unlinkSync(full); removed++; freed += st.size; } catch (_) {}
    }
  } catch (_) {}
  return { removed, freedBytes: freed };
}

/**
 * 删除单个 profile 的磁盘数据（partition + session 映射）
 * 在 deleteProfile 时调用。
 */
async function cleanupProfileData(profileId) {
  if (!profileId) return { removed: [], freedBytes: 0 };
  const userData = getUserDataDir();
  if (!userData) return { removed: [], freedBytes: 0 };
  const removed = [];
  let freed = 0;

  // 1) 删除该 profile 的所有 partition 目录（含带平台前缀的）
  const partitionsDir = path.join(userData, 'Partitions');
  try { await fs.promises.access(partitionsDir); } catch (_) { /* 不存在 */ }
  try {
    for (const e of await fs.promises.readdir(partitionsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const pid = extractProfileIdFromDirName(e.name);
      if (pid === profileId) {
        const full = path.join(partitionsDir, e.name);
        const size = await dirSizeAsync(full);
        if (await rmDirAsync(full)) { removed.push(e.name); freed += size; }
      }
    }
  } catch (_) {}

  // 2) 删除 session-dir-map 文件
  try {
    const mapFile = path.join(userData, 'session-dir-map-' + profileId + '.json');
    const st = await fs.promises.stat(mapFile);
    await fs.promises.unlink(mapFile);
    removed.push('session-dir-map-' + profileId + '.json');
    freed += st.size;
  } catch (_) {}

  return { removed, freedBytes: freed };
}

/** 统计各目录占用（给 UI 显示） */
function getDiskUsage() {
  const userData = getUserDataDir();
  if (!userData) return null;
  const parts = {
    partitions: dirSize(path.join(userData, 'Partitions')),
    screenshots: dirSize(path.join(userData, 'screenshots')),
    logs: dirSize(path.join(userData, 'wyp', 'log')),
    knowledge: dirSize(path.join(userData, 'knowledge')),
  };
  const total = dirSize(userData);
  return { total, ...parts };
}

/**
 * 启动时清理（app ready 后、窗口创建前调用）
 * 只清理安全项：孤儿 partition、旧截图、孤立 session 映射、超大日志
 */
function runStartupCleanup() {
  try {
    const p = cleanupOrphanPartitions();
    const s = cleanupOldScreenshots();
    const m = cleanupOrphanSessionMaps();
    const l = cleanupLogs();
    const freedMB = ((p.freedBytes + s.freedBytes + m.freedBytes + l.freedBytes) / 1024 / 1024).toFixed(2);
    console.log('[Cleanup] 启动清理完成：孤儿partition ' + p.count + ' 个、旧截图 ' + s.removed + ' 张、孤立映射 ' + m.removed + ' 个、截断日志 ' + l.truncated + ' 个，释放 ' + freedMB + ' MB');
    return { partitions: p.count, screenshots: s.removed, sessionMaps: m.removed, logs: l.truncated, freedBytes: p.freedBytes + s.freedBytes + m.freedBytes + l.freedBytes };
  } catch (err) {
    console.error('[Cleanup] 启动清理失败:', err.message);
    return null;
  }
}

/** 手动「清理缓存」：删除当前存活 profile 的纯缓存子目录（保留登录态） */
function cleanCacheOnly() {
  const userData = getUserDataDir();
  if (!userData) return { removed: 0, freedBytes: 0 };
  let removed = 0, freed = 0;
  const roots = [userData, path.join(userData, 'Partitions')];

  const cleanCacheIn = (baseDir) => {
    for (const sub of CACHE_SUBDIRS) {
      const full = path.join(baseDir, sub);
      if (fs.existsSync(full)) {
        const size = dirSize(full);
        if (rmDir(full)) { removed++; freed += size; }
      }
    }
  };

  // 顶层缓存
  cleanCacheIn(userData);
  // 各 partition 缓存
  try {
    const pdir = path.join(userData, 'Partitions');
    if (fs.existsSync(pdir)) {
      for (const e of fs.readdirSync(pdir, { withFileTypes: true })) {
        if (e.isDirectory()) cleanCacheIn(path.join(pdir, e.name));
      }
    }
  } catch (_) {}

  return { removed, freedBytes: freed };
}

module.exports = {
  runStartupCleanup,
  cleanupOrphanPartitions,
  cleanupOldScreenshots,
  cleanupOrphanSessionMaps,
  cleanupLogs,
  cleanupProfileData,
  cleanCacheOnly,
  getDiskUsage,
  dirSize,
  dirSizeAsync,
  rmDirAsync,
};
