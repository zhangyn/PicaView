// 生成测试图片集：超大 JPEG / EXIF 方向 / PNG / BMP / 动图 GIF / 损坏文件
// 用法: node tools/gen-testdata.mjs  (输出到 testdata/)

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { encodePNG } from "./gen-icon.mjs";

const require = createRequire(import.meta.url);
const jpeg = require("jpeg-js");

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "testdata");
mkdirSync(outDir, { recursive: true });

const W = (name, buf) => {
  writeFileSync(join(outDir, name), buf);
  console.log(`  ${name}  ${(buf.length / 1024).toFixed(0)} KB`);
};

// ---------- 渐变像素生成器 ----------
function gradient(w, h, fn) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b, a] = fn(x / w, y / h, x, y);
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a ?? 255;
    }
  }
  return buf;
}

console.log("生成测试图片 →", outDir);

// ---------- 1. 超大 JPEG (6000×4000, 24MP) ----------
{
  console.log("  编码 24MP JPEG（约需十几秒）...");
  const data = gradient(6000, 4000, (u, v) => [
    Math.round(255 * u), Math.round(255 * v), Math.round(255 * Math.sin(u * 12) ** 2),
  ]);
  const enc = jpeg.encode({ data, width: 6000, height: 4000 }, 90);
  W("t01_big_24mp.jpg", enc.data);
}

// ---------- 2. EXIF 方向 JPEG (400×300, orientation 1/6/8) ----------
// 图案：上半红下半绿 —— 方向正确时红色在上
function makeOrientedJpeg(orientation, name) {
  const w = 400, h = 300;
  const data = gradient(w, h, (u, v) =>
    v < 0.5 ? [220, 40, 40] : [40, 180, 70],
  );
  const enc = jpeg.encode({ data, width: w, height: h }, 92);
  const app1 = makeExifApp1(orientation);
  W(name, insertAfterSoi(enc.data, app1));
}

function makeExifApp1(orientation) {
  const tiff = Buffer.alloc(30);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);      // IFD0 offset
  tiff.writeUInt16LE(1, 8);      // entry count
  tiff.writeUInt16LE(0x0112, 10); // Orientation
  tiff.writeUInt16LE(3, 12);      // type SHORT
  tiff.writeUInt32LE(1, 14);      // count
  tiff.writeUInt16LE(orientation, 18); // value
  tiff.writeUInt32LE(0, 22);      // next IFD
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const marker = Buffer.alloc(2);
  marker.writeUInt16BE(payload.length + 2, 0);
  return Buffer.concat([Buffer.from([0xff, 0xe1]), marker, payload]);
}

function insertAfterSoi(jpegBuf, seg) {
  const out = Buffer.alloc(jpegBuf.length + seg.length);
  jpegBuf.copy(out, 0, 0, 2);      // SOI
  seg.copy(out, 2);
  jpegBuf.copy(out, 2 + seg.length, 2);
  return out;
}

makeOrientedJpeg(1, "t02_orient1.jpg");
makeOrientedJpeg(6, "t03_orient6.jpg"); // 需顺时针 90° 摆正
makeOrientedJpeg(8, "t04_orient8.jpg"); // 需逆时针 90° 摆正

// ---------- 3. PNG 渐变 + 透明圆 ----------
{
  const w = 1600, h = 1200;
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = Math.round(255 * x / w);
      rgba[i + 1] = Math.round(255 * y / h);
      rgba[i + 2] = 140;
      const d = Math.hypot(x - w / 2, y - h / 2);
      rgba[i + 3] = d < 380 ? 255 : d < 420 ? Math.round(255 * (420 - d) / 40) : 0;
    }
  }
  W("t05_alpha.png", encodePNG(w, h, rgba));
}

// ---------- 4. BMP (800×600, 24bpp) ----------
{
  const w = 800, h = 600;
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const img = Buffer.alloc(rowSize * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (h - 1 - y) * rowSize + x * 3; // 自下而上
      img[i] = Math.round(255 * y / h);        // B
      img[i + 1] = 120;                        // G
      img[i + 2] = Math.round(255 * x / w);    // R
    }
  }
  const header = Buffer.alloc(54);
  header.write("BM", 0, "latin1");
  header.writeUInt32LE(54 + img.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(w, 18);
  header.writeInt32LE(h, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(img.length, 34);
  W("t06_image.bmp", Buffer.concat([header, img]));
}

// ---------- 5. 动图 GIF (2 帧, 96×96) + 静态 GIF ----------
{
  W("t07_anim.gif", makeGif([
    solidFrame(96, [230, 60, 60]),
    solidFrame(96, [60, 110, 230]),
  ], 40, true));
  W("t08_still.gif", makeGif([patternFrame(120, 80)], 0, false));
}

function solidFrame(size, [r, g, b]) {
  const idx = Buffer.alloc(size * size);
  const half = size / 2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      idx[y * size + x] = (x < half) === (y < half) ? 1 : 0; // 棋盘
  return { w: size, h: size, indices: idx };
}
function patternFrame(w, h) {
  const idx = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      idx[y * w + x] = ((x >> 3) + (y >> 3)) % 2 ? 1 : 2;
  return { w, h, indices: idx };
}

function makeGif(frames, delayCs, loop) {
  const parts = [];
  parts.push(Buffer.from("GIF89a", "latin1"));
  // 逻辑屏幕 + 全局色表 (4 色)
  const maxW = Math.max(...frames.map((f) => f.w));
  const maxH = Math.max(...frames.map((f) => f.h));
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(maxW, 0);
  lsd.writeUInt16LE(maxH, 2);
  lsd[4] = 0x81; // GCT 存在, 4 色 (2^(1+1))
  parts.push(lsd);
  const gct = Buffer.from([
    0x18, 0x18, 0x18,  // 0 深灰
    0xf0, 0xf0, 0xf0,  // 1 白
    0x30, 0x30, 0x30,  // 2 灰
    0, 0, 0,
  ]);
  // 帧里用 rgb 索引映射到色表：棋盘帧用 1/0（白/深灰）够用
  parts.push(gct);
  if (loop) {
    const app = Buffer.from([0x21, 0xff, 0x0b]);
    parts.push(app);
    parts.push(Buffer.from("NETSCAPE2.0", "latin1"));
    parts.push(Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]));
  }
  for (const f of frames) {
    // 图形控制扩展
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x04, 0, 0, 0, 0]));
    parts[parts.length - 1].writeUInt16LE(delayCs, 4);
    // 图像描述符
    const id = Buffer.alloc(10);
    id[0] = 0x2c;
    id.writeUInt16LE(f.w === maxW ? 0 : Math.floor((maxW - f.w) / 2), 1);
    id.writeUInt16LE(f.h === maxH ? 0 : Math.floor((maxH - f.h) / 2), 3);
    id.writeUInt16LE(f.w, 5);
    id.writeUInt16LE(f.h, 7);
    id[9] = 0; // 无局部色表
    parts.push(id);
    // LZW 数据
    const minCodeSize = 2;
    const lzw = lzwEncode(minCodeSize, f.indices);
    parts.push(Buffer.from([minCodeSize]));
    for (let i = 0; i < lzw.length; i += 255) {
      const seg = lzw.subarray(i, i + 255);
      parts.push(Buffer.concat([Buffer.from([seg.length]), seg]));
    }
    parts.push(Buffer.from([0x00]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

// 标准 GIF LZW 编码
function lzwEncode(minCodeSize, indices) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let dict = new Map();
  let next = eoi + 1;
  const bytes = [];
  let cur = 0, curBits = 0;
  const emit = (code) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      bytes.push(cur & 0xff);
      cur >>>= 8;
      curBits -= 8;
    }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    if (dict.has(key)) {
      prefix = dict.get(key);
    } else {
      emit(prefix);
      dict.set(key, next++);
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
      else if (next > 4095) {
        emit(clear);
        dict = new Map();
        next = eoi + 1;
        codeSize = minCodeSize + 1;
      }
      prefix = k;
    }
  }
  emit(prefix);
  emit(eoi);
  if (curBits > 0) bytes.push(cur & 0xff);
  return Buffer.from(bytes);
}

// ---------- 6. 静态 WebP 生成困难（无编码器），下载官方样张 ----------
// （测试阶段另行下载；生成失败不影响其他格式）

// ---------- 7. 损坏文件（错误处理测试） ----------
W("t99_broken.jpg", Buffer.from("this is not a jpeg at all, just plain text"));

console.log("完成");
