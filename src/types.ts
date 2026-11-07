// 前后端共享类型（与 Rust 结构体对应）

export interface ImageEntry {
  name: string;
  path: string;
  size: number;
  modified: number | null; // 毫秒时间戳
  animated: boolean;       // 动图（GIF 多帧 / 动画 WebP / APNG）
}
