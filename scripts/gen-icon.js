#!/usr/bin/env node
/**
 * 生成 TokFree 品牌图标（TF 紫罗兰渐变方块）。
 *
 * 设计：零第三方依赖（仅 Node 内置 zlib），把 about.js 里 TF_ICON_ABOUT 的 SVG 图形
 * 按几何等价关系重新栅格化（44x44 视图坐标 → 任意尺寸 RGBA），再手写 PNG / ICO 编码。
 *
 * 产出：
 *   build/icon.ico  —— Windows 多尺寸（16/32/48/64/128 用 BMP，256 用 PNG）
 *   build/icon.png  —— 512x512（macOS / Linux 备用）
 *
 * 用法：node scripts/gen-icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- 图形定义（与 src/preload/overlay/about.js 的 TF_ICON_ABOUT 等价） ----------
const VB = 44;              // viewBox 边长
const RADIUS = 11;          // <rect rx="11">
const GRAD_FROM = [0x7c, 0x6c, 0xff]; // #7c6cff
const GRAD_TO = [0xa7, 0x8b, 0xfa];   // #a78bfa

// 「TF」字形由轴对齐矩形拼成（与 SVG 的两条 path 完全等价）
const LETTER_RECTS = [
  [9, 13.5, 22, 16.8],      // T 横
  [14, 16.8, 17.3, 30.5],   // T 竖
  [25, 13.5, 35, 16.8],     // F 顶横
  [25, 16.8, 28.3, 30.5],   // F 竖
  [28.3, 20.8, 33.5, 24.1], // F 中横
];

function inRounded(x, y) {
  if (x < 0 || y < 0 || x > VB || y > VB) return false;
  const cx = Math.min(Math.max(x, RADIUS), VB - RADIUS);
  const cy = Math.min(Math.max(y, RADIUS), VB - RADIUS);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}

function inLetters(x, y) {
  for (let i = 0; i < LETTER_RECTS.length; i++) {
    const r = LETTER_RECTS[i];
    if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) return true;
  }
  return false;
}

/**
 * 栅格化为 RGBA（超采样抗锯齿）。
 * @param {number} size 输出边长
 * @param {number} ss 每像素超采样倍数（ss x ss）
 */
function rasterize(size, ss) {
  const out = Buffer.alloc(size * size * 4);
  const scale = VB / size;
  const inv = 1 / (ss * ss);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgCov = 0, ltCov = 0;
      let sr = 0, sg = 0, sb = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) * scale;
          const y = (py + (sy + 0.5) / ss) * scale;
          if (!inRounded(x, y)) continue;
          bgCov++;
          // objectBoundingBox 渐变 (0,0)->(1,1) 在 44x44 用户坐标下的投影
          const t = Math.min(1, Math.max(0, (x + y) / (2 * VB)));
          sr += GRAD_FROM[0] + (GRAD_TO[0] - GRAD_FROM[0]) * t;
          sg += GRAD_FROM[1] + (GRAD_TO[1] - GRAD_FROM[1]) * t;
          sb += GRAD_FROM[2] + (GRAD_TO[2] - GRAD_FROM[2]) * t;
          if (inLetters(x, y)) ltCov++;
        }
      }
      if (bgCov === 0) continue; // 完全在圆角方块外 -> 透明
      const aBg = bgCov * inv;
      const aLt = ltCov * inv;
      const cr = sr / bgCov, cg = sg / bgCov, cb = sb / bgCov;
      // 白色文字叠加在渐变底上
      const aOut = aLt + aBg * (1 - aLt);
      const o = (py * size + px) * 4;
      out[o] = Math.round((255 * aLt + cr * aBg * (1 - aLt)) / aOut);
      out[o + 1] = Math.round((255 * aLt + cg * aBg * (1 - aLt)) / aOut);
      out[o + 2] = Math.round((255 * aLt + cb * aBg * (1 - aLt)) / aOut);
      out[o + 3] = Math.round(aOut * 255);
    }
  }
  return out;
}

// ---------- PNG 编码 ----------
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- ICO 编码 ----------
/** 32bpp BITMAPINFOHEADER + BGRA 像素（自下而上）+ 1bpp AND 掩码 */
function bmpEntry(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // 高度 = 像素 + AND 掩码
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);      // BI_RGB
  header.writeUInt32LE(size * size * 4, 20);

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;
    const dstRow = y * size * 4;
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4, d = dstRow + x * 4;
      pixels[d] = rgba[s + 2];     // B
      pixels[d + 1] = rgba[s + 1]; // G
      pixels[d + 2] = rgba[s];     // R
      pixels[d + 3] = rgba[s + 3]; // A
    }
  }
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRowBytes * size); // 32bpp 下掩码全 0 即可
  return Buffer.concat([header, pixels, mask]);
}

function buildICO(entries) {
  const count = entries.length;
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);      // reserved
  dir.writeUInt16LE(1, 2);      // type: icon
  dir.writeUInt16LE(count, 4);

  const dirEntries = [];
  const blobs = [];
  let offset = 6 + 16 * count;
  for (let i = 0; i < count; i++) {
    const e = entries[i];
    const de = Buffer.alloc(16);
    de[0] = e.size >= 256 ? 0 : e.size; // 256 记作 0
    de[1] = e.size >= 256 ? 0 : e.size;
    de[2] = 0; // colorCount
    de[3] = 0; // reserved
    de.writeUInt16LE(1, 4);   // planes
    de.writeUInt16LE(32, 6);  // bitCount
    de.writeUInt32LE(e.data.length, 8);
    de.writeUInt32LE(offset, 12);
    offset += e.data.length;
    dirEntries.push(de);
    blobs.push(e.data);
  }
  return Buffer.concat([dir].concat(dirEntries, blobs));
}

// ---------- 主流程 ----------
const OUT_DIR = path.join(__dirname, '..', 'build');
fs.mkdirSync(OUT_DIR, { recursive: true });

const SIZES = [16, 32, 48, 64, 128, 256];
const entries = SIZES.map(function (s) {
  const ss = s >= 128 ? 3 : 4;
  const rgba = rasterize(s, ss);
  return { size: s, data: s === 256 ? encodePNG(s, rgba) : bmpEntry(s, rgba) };
});

const icoPath = path.join(OUT_DIR, 'icon.ico');
fs.writeFileSync(icoPath, buildICO(entries));

const pngPath = path.join(OUT_DIR, 'icon.png');
fs.writeFileSync(pngPath, encodePNG(512, rasterize(512, 2)));

console.log('icon.ico  ->', icoPath, fs.statSync(icoPath).size, 'bytes,', SIZES.join('/'));
console.log('icon.png  ->', pngPath, fs.statSync(pngPath).size, 'bytes, 512x512');
