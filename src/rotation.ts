// "仅旋转显示"模式的旋转记录
//
// 只记在 settings.json 里，绝不动图片文件。记录附带 大小 + 修改时间，
// 文件被外部修改/替换后自动失效（回到原始方向），避免用旧方向误导。
// 用户把设置改成"写入文件"后，这些记录会在下一次旋转时一起落地。

import { getSettings, updateSettings, type RotationMark } from "./settings";

const MAX_MARKS = 1024;

function keyOf(path: string): string {
  return path.replace(/\//g, "\\").toLowerCase();
}

function writeMarks(next: RotationMark[]) {
  // 只保留最近的若干条，避免 settings.json 无限膨胀
  updateSettings({ rotations: next.slice(-MAX_MARKS) });
}

/** 当前记录的显示旋转（顺时针 90° 次数 0..3）；文件已变则视为 0 */
export function quarterOf(path: string, size: number, mtime: number | null): number {
  const k = keyOf(path);
  const mark = getSettings().rotations.find((m) => keyOf(m.path) === k);
  if (!mark) return 0;
  if (mark.size !== size || mark.mtime !== (mtime ?? 0)) return 0;
  return ((mark.quarter % 4) + 4) % 4;
}

/** 设置显示旋转；quarter 为 0 表示删除记录 */
export function setQuarter(
  path: string,
  size: number,
  mtime: number | null,
  quarter: number,
) {
  const k = keyOf(path);
  const q = ((quarter % 4) + 4) % 4;
  const rest = getSettings().rotations.filter((m) => keyOf(m.path) !== k);
  writeMarks(q === 0 ? rest : [...rest, { path, quarter: q, size, mtime: mtime ?? 0 }]);
}

export function clearQuarter(path: string) {
  const k = keyOf(path);
  writeMarks(getSettings().rotations.filter((m) => keyOf(m.path) !== k));
}

/** 重命名后把记录迁到新路径（内容没变，方向继续有效） */
export function rekeyQuarter(oldPath: string, newPath: string) {
  const k = keyOf(oldPath);
  const marks = getSettings().rotations;
  const i = marks.findIndex((m) => keyOf(m.path) === k);
  if (i < 0) return;
  const next = marks.slice();
  next[i] = { ...next[i], path: newPath };
  writeMarks(next);
}

/**
 * 把显示旋转应用到解码结果上（顺时针 90° × quarter）。
 * 返回新位图；成功时旧位图已被关闭，失败时原样返回（至少不丢画面）。
 */
export async function applyQuarter(bmp: ImageBitmap, quarter: number): Promise<ImageBitmap> {
  const q = ((quarter % 4) + 4) % 4;
  if (!q) return bmp;
  const swap = q % 2 === 1;
  const w = swap ? bmp.height : bmp.width;
  const h = swap ? bmp.width : bmp.height;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  if (!ctx) return bmp;
  ctx.translate(w / 2, h / 2);
  ctx.rotate((q * Math.PI) / 2);
  ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  try {
    const out = await createImageBitmap(cv);
    bmp.close();
    return out;
  } catch {
    return bmp;
  }
}
