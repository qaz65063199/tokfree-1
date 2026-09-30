/**
 * Profile 管理模块
 * 每个 profile 对应一个独立的 partition，实现类似 Chrome 的多用户隔离。
 * profile 列表持久化在 userData/profile-list.json。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

let PROFILE_FILE = null;

function getProfileFile() {
  if (!PROFILE_FILE) {
    PROFILE_FILE = path.join(app.getPath('userData'), 'profile-list.json');
  }
  return PROFILE_FILE;
}

/** 补全单个 profile 的缺省字段（兼容旧数据，纯内存不写盘） */
function normalizeProfile(p) {
  if (!p) return p;
  // 禁言状态：过期自动清理（不写盘，纯内存过滤）
  if (p.banned && p.banned.until && p.banned.until <= Date.now()) {
    p.banned = null;
  }
  if (!p.account) {
    p.account = { label: '', email: '', group: '', status: 'active', quotaUsed: 0, quotaLimit: 0, lastUsed: null, note: '' };
  }
  if (!p.fingerprint) {
    p.fingerprint = { enabled: false, seed: Math.floor(Math.random() * 1000000), os: '', timezone: '', language: '', screenWidth: 0, screenHeight: 0, hardwareConcurrency: 0, deviceMemory: 0 };
  }
  if (!p.proxy) {
    p.proxy = { enabled: false, mode: 'direct', protocol: 'http', host: '', port: 0, username: '', password: '', bypass: '' };
  }
  if (!p.apiConfig) {
    p.apiConfig = { baseUrl: 'http://localhost:3000/v1', authKey: '', model: 'auto', image: false };
  }
  return p;
}

function readProfiles() {
  try {
    const file = getProfileFile();
    if (fs.existsSync(file)) {
      const list = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(list)) return list.map(normalizeProfile);
      return [];
    }
  } catch (err) {
    console.error('[Profile] 读取 profile 列表失败:', err.message);
  }
  return [];
}

function writeProfiles(profiles) {
  try {
    const file = getProfileFile();
    fs.writeFileSync(file, JSON.stringify(profiles, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Profile] 写入 profile 列表失败:', err.message);
  }
}

/**
 * 创建新 profile
 * @param {string} name 显示名称
 * @param {string} providerId 平台 id（默认 deepseek）
 */
function createProfile(name, providerId) {
  const profiles = readProfiles();
  // providerId 为空表示平台未确定，首次打开会显示平台选择页
  const pid = providerId || '';
  const id = 'profile-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const profile = {
    id,
    providerId: pid,
    name: name || ('窗口' + (profiles.length + 1)),
    partition: 'persist:' + (pid ? pid + ':' : '') + id,
    createdAt: new Date().toISOString(),
    // 账号池元数据（轻量：本地 JSON，无数据库）
    account: {
      label: '',
      email: '',
      group: '',
      status: 'active',   // active | limited | expired | disabled
      quotaUsed: 0,
      quotaLimit: 0,      // 0 表示不限制
      lastUsed: null,
      note: '',
    },
    // 账号禁言/封禁（持久化：窗口关闭后仍保留，倒计时结束自动失效）
    banned: null,   // { until: 时间戳(0=未知), text: '', keyword: '', since: 时间戳 }
    
    // 指纹伪装配置（seed 决定随机身份，同 seed 稳定）
    fingerprint: {
      enabled: false,
      seed: Math.floor(Math.random() * 1000000),
      os: '',            // 空=跟随真实系统
      timezone: '',
      language: '',
      screenWidth: 0,
      screenHeight: 0,
      hardwareConcurrency: 0,
      deviceMemory: 0,
    },
    // 代理配置
    proxy: {
      enabled: false,
      mode: 'direct',    // direct | fixed_servers | pac_script
      protocol: 'http',  // http | https | socks5
      host: '',
      port: 0,
      username: '',
      password: '',
      bypass: '',
    },
    // API 型 provider（api-openai）配置：壳层配置条持久化于此
    apiConfig: {
      baseUrl: 'http://localhost:3000/v1',
      authKey: '',
      model: 'auto',
      image: false,
    },
  };
  profiles.push(profile);
  writeProfiles(profiles);
  console.log('[Profile] 已创建:', profile.id, profile.name, 'provider=' + (pid || '(未确定)'));
  return profile;
}

/**
 * 获取默认 profile，若不存在则创建
 */
function getDefaultProfile() {
  const profiles = readProfiles();
  if (profiles.length > 0) return profiles[0];
  return createProfile('默认窗口', '');
}

/**
 * 根据 id 获取 profile
 */
function getProfileById(id) {
  return readProfiles().find(p => p.id === id) || null;
}

/**
 * 删除 profile
 */
function deleteProfile(id) {
  const profiles = readProfiles();
  const idx = profiles.findIndex(p => p.id === id);
  if (idx === -1) return false;
  profiles.splice(idx, 1);
  writeProfiles(profiles);
  return true;
}

/**
 * 更新 profile 平台
 */
function updateProfileProvider(id, providerId) {
  const profiles = readProfiles();
  const p = profiles.find(x => x.id === id);
  if (!p || !providerId) return null;
  p.providerId = providerId;
  p.partition = 'persist:' + providerId + ':' + id;
  writeProfiles(profiles);
  return p;
}

/**
 * 更新 profile 显示名称
 */
function updateProfileName(id, name) {
  const profiles = readProfiles();
  const p = profiles.find(x => x.id === id);
  if (!p || !name || !name.trim()) return null;
  p.name = name.trim();
  writeProfiles(profiles);
  return p;
}

/**
 * 通用更新：把 patch 合并进指定 profile（浅合并顶层，深合并 account/fingerprint/proxy）
 * @param {string} id profile id
 * @param {object} patch 要更新的字段
 */
function updateProfile(id, patch) {
  if (!id || !patch || typeof patch !== 'object') return null;
  const profiles = readProfiles();
  const p = profiles.find(x => x.id === id);
  if (!p) return null;
  // 顶层字段（不允许改 id/partition）
  for (const k of Object.keys(patch)) {
    if (k === 'id' || k === 'partition') continue;
    if (k === 'account' || k === 'fingerprint' || k === 'proxy' || k === 'apiConfig') {
      p[k] = Object.assign({}, p[k] || {}, patch[k] || {});
    } else {
      p[k] = patch[k];
    }
  }
  writeProfiles(profiles);
  return p;
}

/** 更新账号元数据 */
function updateProfileAccount(id, account) {
  return updateProfile(id, { account });
}

/** 设置账号禁言状态（持久化，窗口关闭后仍保留） */
function setProfileBanned(id, info) {
  if (!id) return null;
  const i = info || {};
  return updateProfile(id, {
    banned: {
      until: i.until || 0,
      text: i.text || '',
      keyword: i.keyword || '',
      since: Date.now(),
    },
  });
}

/** 清除账号禁言状态 */
function clearProfileBanned(id) {
  if (!id) return null;
  return updateProfile(id, { banned: null });
}

/** 读取账号禁言状态（过滤掉已过期的；过期则顺手清理） */
function getProfileBanned(id) {
  const p = getProfileById(id);
  if (!p || !p.banned) return null;
  const b = p.banned;
  // 有过期时间且已过期 → 清理并返回 null
  if (b.until && b.until <= Date.now()) {
    try { clearProfileBanned(id); } catch (_) {}
    return null;
  }
  return b;
}

/** 更新代理配置 */
function updateProfileProxy(id, proxy) {
  return updateProfile(id, { proxy });
}

/** 更新指纹配置 */
function updateProfileFingerprint(id, fingerprint) {
  return updateProfile(id, { fingerprint });
}

/**
 * 查询账号池账号的占用情况（哪些窗口绑定了它）
 * @returns {Object} { [accountId]: [{ profileId, profileName }] }
 */
function getAccountUsage() {
  const usage = {};
  try {
    const profiles = readProfiles();
    for (const p of profiles) {
      const accId = p && p.account ? p.account.accountId : null;
      if (!accId) continue;
      if (!usage[accId]) usage[accId] = [];
      usage[accId].push({ profileId: p.id, profileName: p.name || '' });
    }
  } catch (_) {}
  return usage;
}

module.exports = {
  readProfiles,
  writeProfiles,
  createProfile,
  getDefaultProfile,
  getProfileById,
  updateProfileName,
  updateProfileProvider,
  deleteProfile,
  updateProfile,
  updateProfileAccount,
  updateProfileProxy,
  updateProfileFingerprint,
  getAccountUsage,
  setProfileBanned,
  clearProfileBanned,
  getProfileBanned,
};
