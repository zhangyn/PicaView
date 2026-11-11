// 前后端共享类型（与 Rust 结构体对应）

export interface ImageEntry {
  name: string;
  path: string;
  size: number;
  modified: number | null; // 毫秒时间戳（后端返回字段，前端暂未使用）
  animated: boolean;       // 动图（GIF 多帧 / 动画 WebP / APNG）
}

/** EXIF 拍摄信息（read_exif 返回） */
export interface ExifInfo {
  orientation: number;
  date_taken: string | null;
  camera: string | null;
}

// ---------- 详细信息（get_image_details 返回，字段名与 Rust 一致） ----------

export interface DetailsFile {
  name: string;
  path: string;
  folder: string | null;
  size: number;
  created: number | null;  // 毫秒时间戳
  modified: number | null;
  accessed: number | null;
  readonly: boolean;
  format: string | null;   // 按文件内容嗅探：JPEG / PNG / GIF / BMP / WebP
  ext: string;             // 小写扩展名（不含点）
  ext_mismatch: boolean;   // 扩展名与真实格式不符
  animated: boolean;
}

export interface DetailsImage {
  width: number | null;
  height: number | null;
  megapixels: number | null;
  orientation: number | null; // EXIF 方向 1..8
  dpi_x: number | null;
  dpi_y: number | null;
  color_space: string | null;
  has_icc: boolean | null;
}

export interface DetailsShot {
  make: string | null;
  model: string | null;
  lens: string | null;
  software: string | null;
  date_taken: string | null;
  exposure_time: string | null;
  f_number: string | null;
  iso: number | null;
  focal_length: string | null;
  focal_length_35mm: number | null;
  exposure_bias: string | null;
  metering_mode: string | null;
  flash: string | null;
  white_balance: string | null;
  exposure_program: string | null;
}

export interface DetailsGps {
  latitude: number;        // 十进制度，南纬为负
  longitude: number;       // 十进制度，西经为负
  altitude: number | null; // 米
}

export interface ImageDetails {
  file: DetailsFile;
  image: DetailsImage;
  shot: DetailsShot | null;
  gps: DetailsGps | null;
}
