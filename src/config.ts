// 集中的可调常量（数值与原实现保持一致，除非注明）

// ---------- 加载管线 ----------

/** 连续翻页时完整图加载的防抖：停止翻页这么久后才读取/解码全图 */
export const FULL_LOAD_DEBOUNCE_MS = 100;
/** 详情面板打开时切图：停止切换这么久后才请求详细信息 */
export const DETAILS_DEBOUNCE_MS = 150;

/** 当前图加载完成后，延迟这么久再预加载邻图（期间再次翻页会取消） */
export const PRELOAD_DELAY_MS = 120;
/** 邻图预加载（tier）同时进行的最大数量 */
export const PRELOAD_CONCURRENCY = 2;
/** 邻图低清位图缓存上限 */
export const TIER_MAX = 6;
/** tier 宽度 = 视口设备像素宽 × 该系数 */
export const TIER_SCALE = 1.25;
/** 视口宽度小于该值时视为"窗口不可用"（隐藏/最小化），不生成 tier */
export const TIER_MIN_VIEWPORT_PX = 64;
/** tier 位图宽度的下限：避免极小视口解出 1px 的垃圾位图 */
export const TIER_MIN_PX = 256;
/**
 * 全图解码上限：位图长边 = 视口设备长边 × 该系数。
 * 放大到该系数以内都还是"不放大位图"，再往上后台补一次原图（见 LOD_UPGRADE_SCALE）。
 */
export const LOD_VIEW_SCALE = 2;
/** 全图解码长边下限：窗口很小时也不至于解得太糙 */
export const LOD_MIN_LONG_SIDE = 2048;
/** 每个源像素摊到的设备像素达到该值（约等于放大到 100%）时，后台补原图 */
export const LOD_UPGRADE_AT = 0.75;

/** 动图/兜底 img 通道 blob URL 池容量 */
export const BLOB_URL_POOL_MAX = 3;
/** loading 指示延迟显示，快速加载不闪烁 */
export const LOADING_DELAY_MS = 180;

// ---------- 视图 ----------

/** 灯箱模式下图片占视口的比例（Picasa 式适中展示） */
export const LIGHTBOX_FIT_RATIO = 0.78;
/** 灯箱提示文字显示时长 */
export const LIGHTBOX_HINT_MS = 3500;
/** 缩放指示显示时长 */
export const ZOOM_INDICATOR_MS = 900;
/** 键盘 +/- 缩放步进 */
export const KEY_ZOOM_STEP = 1.25;
/** 键盘方向键平移占视口的比例（已放大时） */
export const KEY_PAN_RATIO = 0.15;
/** 滚轮缩放：每 100 个 delta 的缩放底数 */
export const WHEEL_ZOOM_BASE = 1.2;
/** 滚轮 deltaMode=行(1) 时换算成像素当量的系数（Chromium 默认行高） */
export const WHEEL_LINE_PX = 16;
/** 滚轮 deltaMode=页(2) 时换算成像素当量的系数 */
export const WHEEL_PAGE_PX = 400;
/** 单次滚轮事件的最大像素当量，避免高速滚动一帧跳太远 */
export const WHEEL_DELTA_CAP = 300;
/** 缩放滑块上限（百分比） */
export const SLIDER_MAX_PCT = 400;
/** 缩放滑块下限 = 适应百分比 × 该系数 */
export const SLIDER_MIN_FIT_FACTOR = 0.1;

// ---------- 渲染 ----------

/** 交互（拖动/滚轮缩放）停止多久后，补一次高质量重绘 */
export const HQ_RESTORE_MS = 150;
/** rAF 看门狗：超时未触发就同步绘制 */
export const RAF_WATCHDOG_MS = 250;
/** rAF 延迟超过该值视为被系统暂停（诊断用） */
export const RAF_SUSPEND_WARN_MS = 120;
/** 帧保活间隔：页面可见时静默补推一帧 */
export const KEEPALIVE_MS = 1500;
/**
 * canvas 2D 上下文是否带 willReadFrequently（强制 CPU 光栅化）。
 * 代码里没有 getImageData 等读回需求，默认关闭以走 GPU；
 * 若个别显卡驱动出现画面透明/不呈现，可改回 true 作为兜底。
 */
export const CANVAS_WILL_READ_FREQUENTLY = false;

// ---------- 胶片条 ----------

export const THUMB_W = 128;
export const THUMB_H = 88;
/** 内存中保留已绘制缩略图的数量上限 */
export const THUMB_MAX_LOADED = 240;
/** 当前图两侧优先加载（并始终保留）的半径 */
export const THUMB_AROUND_RADIUS = 14;
/** 前端缩略图请求并发（后端上限为 3，这里略高以填满管线） */
export const THUMB_CONCURRENCY = 4;
/** IntersectionObserver 水平预取距离（相对胶片条宽度，约 2 屏） */
export const THUMB_PREFETCH_MARGIN = "200%";

// ---------- 输出 / 操作 ----------

/** 复制到剪贴板的图片长边上限（聊天软件与文档用不到原图那么大，也免得剪贴板塞几百 MB） */
export const COPY_IMAGE_MAX_SIDE = 4096;
/** 设置落盘防抖：连点开关不必每次都写文件 */
export const SETTINGS_SAVE_DEBOUNCE_MS = 400;
/** 旋转撤销栈深度 */
export const ROTATE_UNDO_MAX = 10;

// ---------- 其他 ----------

/** 控件闲置隐藏延迟 */
export const IDLE_HIDE_MS = 3000;
/** toast 默认显示时长 */
export const TOAST_MS = 2500;
/** 幻灯片切换间隔 */
export const SLIDESHOW_INTERVAL_MS = 3000;
/** 窗口显示兜底超时（隐藏窗口下 rAF 可能不跑） */
export const SHOW_WINDOW_FALLBACK_MS = 1200;
