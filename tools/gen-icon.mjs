// 生成应用图标（纯 Node，无第三方依赖）：暗色圆角方块 + 光圈图形
// 输出 tools/app-icon.png (1024×1024)，供 `npx tauri icon` 使用

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------- PNG 编码 ----------
const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = ~0;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
export function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 图形绘制 ----------
const S = 1024;
const px = Buffer.alloc(S * S * 4);

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const sdRoundRect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
};
// 点到线段距离
function sdSeg(px_, py_, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp01(((px_ - ax) * abx + (py_ - ay) * aby) / (abx * abx + aby * aby));
  return Math.hypot(px_ - (ax + abx * t), py_ - (ay + aby * t));
}

const CX = S / 2, CY = S / 2;
const RING_R = 310, RING_W = 40;   // 光圈外环
const BLADE_W = 34;                 // 叶片线宽
const HUB = 130;                    // 叶片内端半径

// 6 片叶片线段：从外环上一点，斜切向内侧偏转一点的角度
const segs = [];
for (let k = 0; k < 6; k++) {
  const a = (k * 60 * Math.PI) / 180;
  const a2 = a + (128 * Math.PI) / 180;
  segs.push([
    CX + RING_R * Math.cos(a), CY + RING_R * Math.sin(a),
    CX + HUB * Math.cos(a2), CY + HUB * Math.sin(a2),
  ]);
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    // 背景：圆角方块（带 1.5px 抗锯齿）
    const bgD = sdRoundRect(x + 0.5, y + 0.5, CX, CY, S / 2 - 8, S / 2 - 8, 190);
    const bgA = clamp01(0.5 - bgD / 1.5);
    if (bgA <= 0) continue; // 外部透明

    // 前景：光圈外环 + 叶片（白色）
    const r = Math.hypot(x + 0.5 - CX, y + 0.5 - CY);
    const ringA = clamp01(0.5 - (Math.abs(r - RING_R) - RING_W / 2) / 1.5);
    let bladeA = 0;
    for (const [ax, ay, bx, by] of segs) {
      const d = sdSeg(x + 0.5, y + 0.5, ax, ay, bx, by);
      bladeA = Math.max(bladeA, clamp01(0.5 - (d - BLADE_W / 2) / 1.5));
    }
    const fgA = Math.max(ringA, bladeA);

    // 底色 #26282c，前景 #f2f4f7
    const base = [0x26, 0x28, 0x2c];
    const fg = [0xf2, 0xf4, 0xf7];
    const out = [0, 1, 2].map((k) => base[k] + (fg[k] - base[k]) * fgA);
    px[i] = Math.round(out[0]);
    px[i + 1] = Math.round(out[1]);
    px[i + 2] = Math.round(out[2]);
    px[i + 3] = Math.round(255 * bgA);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, "app-icon.png"), encodePNG(S, S, px));
console.log("app-icon.png 已生成 (1024×1024)");
