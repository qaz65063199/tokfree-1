#!/usr/bin/env node
// ShardX MCP 启动包装器：用 api_secret 现签 JWT，再启动官方 index.js（ESM）
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const settingsPath = path.join(process.env.APPDATA, 'shardx-launcher', 'settings.json');
let secret = '', port = 40325;
try {
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  secret = s.api_secret || '';
  port = s.api_port || 40325;
} catch (e) { console.error('[ShardX wrapper] 读取 settings.json 失败:', e.message); }

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let token = '';
if (secret) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub: 'api', iat: now, exp: now + 315360000 }));
  const sig = b64url(crypto.createHmac('sha256', secret).update(header + '.' + payload).digest());
  token = header + '.' + payload + '.' + sig;
}

process.env.SHARDX_API = process.env.SHARDX_API || ('http://127.0.0.1:' + port);
process.env.SHARDX_TOKEN = process.env.SHARDX_TOKEN || token;

await import('file:///' + path.join(__dirname, 'index.js').replace(/\\/g, '/'));