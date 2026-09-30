#!/usr/bin/env node
/**
 * 上传更新产物到 Cloudflare R2（S3 API 方式，无需 wrangler）
 *
 * 用法：
 *   npm run upload:r2                 # 读取 .env 或环境变量，真实上传
 *   npm run upload:r2 -- --dry-run    # 只打印将要上传的文件清单，不真正上传
 *
 * 配置来源（优先级：环境变量 > 项目根目录 .env 文件）：
 *   R2_ACCOUNT_ID       必填，R2 账户 ID
 *   R2_ACCESS_KEY_ID    必填，S3 API Access Key ID
 *   R2_SECRET_ACCESS_KEY 必填，S3 API Secret Access Key
 *   R2_BUCKET           可选，存储桶名，默认 "tokfree-dl"
 *   DIST_DIR            可选，产物目录，默认 "dist"
 *   R2_PREFIX           可选，对象前缀，默认空（强烈建议留空，见下）
 *
 * 上传内容：dist/ 下的 *.exe（安装包）、latest.yml（更新清单，必需）、*.blockmap（增量，可选）
 *
 * ⚠️ 对象 Key 默认不带前缀：electron-updater 的 generic provider 会请求
 *    https://dl.tokfree.win/latest.yml，且 latest.yml 内的文件名是相对路径。
 *    若设置了 R2_PREFIX，更新会失败（除非同步改 publish url）。
 */
const fs = require('fs');
const path = require('path');

// ---------- 极简 .env 解析（不引入 dotenv 依赖） ----------
function loadDotenv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  let text;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch (e) {
    console.warn('⚠️  读取 .env 失败：' + e.message);
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // 去掉成对引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

// ---------- 参数解析 ----------
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

function fail(msg) {
  console.error('\n❌ ' + msg + '\n');
  process.exit(1);
}

function contentTypeFor(name) {
  const lower = name.toLowerCase();
  if (lower === 'latest.yml' || lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'text/yaml';
  return 'application/octet-stream';
}

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

async function main() {
  loadDotenv();

  const ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
  const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
  const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
  const BUCKET = process.env.R2_BUCKET || 'tokfree-dl';
  const DIST_DIR = process.env.DIST_DIR || 'dist';
  const PREFIX = process.env.R2_PREFIX || '';

  // 1) 定位产物目录
  const distPath = path.resolve(process.cwd(), DIST_DIR);
  if (!fs.existsSync(distPath) || !fs.statSync(distPath).isDirectory()) {
    fail('产物目录不存在: ' + distPath + '\n   请先执行 npm run build:win:local 打包。');
  }

  // 2) 收集待上传文件
  const entries = fs.readdirSync(distPath);
  const files = entries.filter((f) => {
    const lower = f.toLowerCase();
    return lower.endsWith('.exe') || lower.endsWith('.blockmap') || f === 'latest.yml';
  });

  if (files.length === 0) {
    fail('在 ' + distPath + ' 未找到任何可上传文件（*.exe / latest.yml / *.blockmap）。');
  }

  const hasLatest = files.includes('latest.yml');
  if (!hasLatest) {
    console.warn('\n⚠️  未找到 latest.yml —— 自动更新的关键清单缺失，用户端将无法检测到新版本！');
    console.warn('    请确认打包为 NSIS target 且 publish 配置正确。\n');
  }

  // 3) 前缀警告
  if (PREFIX) {
    console.warn('\n⚠️  检测到 R2_PREFIX=' + PREFIX);
    console.warn('    设置前缀会导致 electron-updater 找不到 latest.yml（它请求的是根路径）。');
    console.warn('    除非你已同步修改 package.json 的 publish url，否则更新会失败！\n');
  }

  // 4) 打印计划
  console.log('\n📦 准备上传到 Cloudflare R2' + (DRY_RUN ? '（DRY-RUN 模式，不会真正上传）' : ''));
  console.log('   账户 : ' + (ACCOUNT_ID || '(未设置)'));
  console.log('   桶   : ' + BUCKET);
  console.log('   目录 : ' + distPath);
  console.log('   前缀 : ' + (PREFIX || '(无)'));
  console.log('   文件 : ' + files.length + ' 个\n');

  const planned = files.map((f) => {
    const abs = path.join(distPath, f);
    const key = PREFIX + f;
    const size = fs.statSync(abs).size;
    return { f, abs, key, size, contentType: contentTypeFor(f) };
  });

  for (const p of planned) {
    console.log('   • r2://' + BUCKET + '/' + p.key + '  (' + humanSize(p.size) + ', ' + p.contentType + ')');
  }
  console.log('');

  if (DRY_RUN) {
    console.log('✅ DRY-RUN 完成：以上是将要上传的文件清单，未做任何真实上传。');
    console.log('   去掉 --dry-run 即可真正上传。\n');
    return;
  }

  // 5) 校验密钥（真实上传前）
  if (!ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY) {
    fail(
      '缺少 R2 凭据（R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）。\n' +
        '   请复制 .env.example 为 .env 并填入真实值，或用环境变量传入。\n' +
        '   仅想验证逻辑？用：npm run upload:r2 -- --dry-run'
    );
  }

  // 6) 懒加载 SDK（dry-run 时无需加载）
  let S3Client, PutObjectCommand;
  try {
    ({ S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'));
  } catch (e) {
    fail('未安装 @aws-sdk/client-s3。请执行：npm install --save-dev @aws-sdk/client-s3');
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: 'https://' + ACCOUNT_ID + '.r2.cloudflarestorage.com',
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    },
  });

  // 7) 逐个上传
  let ok = 0;
  let failCount = 0;
  for (const p of planned) {
    const isKey = p.f === 'latest.yml';
    console.log('⬆️  上传 ' + p.f + ' (' + humanSize(p.size) + ') → r2://' + BUCKET + '/' + p.key);
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: p.key,
          Body: fs.readFileSync(p.abs),
          ContentType: p.contentType,
        })
      );
      ok++;
      console.log('   ✅ 完成' + (isKey ? '（更新清单已就位）' : '') + '\n');
    } catch (e) {
      failCount++;
      console.error('   ❌ 失败：' + (e && e.message ? e.message : e) + '\n');
    }
  }

  // 8) 汇总
  console.log('========== 上传结果 ==========');
  console.log('成功: ' + ok + '，失败: ' + failCount);
  if (failCount > 0) {
    console.error('\n部分文件上传失败。请检查：');
    console.error('  1) R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY 是否正确（Object Read & Write 权限）');
    console.error('  2) R2_ACCOUNT_ID 是否正确');
    console.error('  3) R2_BUCKET（' + BUCKET + '）是否存在');
    console.error('  4) 网络是否可达 *.r2.cloudflarestorage.com');
    process.exit(1);
  }
  console.log('\n🎉 全部上传完成。');
  console.log('   验证：打开 https://dl.tokfree.win/latest.yml 应能看到新版本号。');
  if (!hasLatest) console.log('   ⚠️  注意：本次未上传 latest.yml，更新不会生效！');
  console.log('');
}

main().catch((e) => {
  console.error('\n❌ 未预期的错误：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
