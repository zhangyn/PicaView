# PicaView

极简看图软件——复刻 Google Picasa「查看器」的体验：快、顺滑、只看图。
无图库、无相册、无人脸、无编辑、无联网。

![tech](https://img.shields.io/badge/Tauri-2-blue) ![platform](https://img.shields.io/badge/Windows-10%2F11-lightgrey)

## 功能

- **秒开**：JPEG 先显示 EXIF 内嵌预览，后台解码全图后无缝替换
- **翻页瞬时响应**：邻图预解码为视口大小的低清位图（tier），翻页即现
- **顺滑缩放**：滚轮以光标为中心缩放，GPU 合成，双击切换 适应窗口 ↔ 实际大小
- **胶片条**：底部缩略图（磁盘缓存，二次打开秒出），T 键开关
- **动图**：GIF / 动画 WebP / APNG 自动播放
- **无损旋转**：JPEG 走 libjpeg-turbo 无损变换（不重编码），并复位 EXIF 方向
- **文件操作**：F2 重命名；Delete 移入回收站，Shift+Delete 彻底删除（均带确认）
- **信息浮层**：文件名、序号、尺寸、大小、拍摄时间、相机型号
- **幻灯片**：3 秒自动播放 + 全屏
- **文件关联**：安装后双击图片直接打开；已运行时二次打开转发到既有窗口

## 快捷键

| 键 | 功能 | 键 | 功能 |
|---|---|---|---|
| ← / → | 翻页（放大时为平移） | 1 / F | 实际大小 / 适应窗口 |
| ↑ / ↓ | 平移（放大时） | + / - | 缩放 |
| Home / End | 首张 / 末张 | 双击 | 适应 ↔ 实际 |
| Enter / F11 | 全屏 | 滚轮 | 光标为中心缩放 |
| S | 幻灯片 | 拖拽 | 平移 |
| T | 胶片条 | 鼠标侧键 | 前进 / 后退 |
| I | 信息浮层 | L / R | 左旋 / 右旋 |
| **B** | **只看图片（隐藏标题栏）** | **M** | **蒙板（图片外灰色半透明）** |
| F2 | 重命名 | Delete | 移入回收站 |
| Shift+Delete | 彻底删除 | Esc | 退出幻灯片/只看图片模式 |

右下角有**可拖动缩放滑块**（对数刻度，实时显示百分比；滚轮/快捷键与滑块双向同步）。

## 支持格式

JPEG · PNG · BMP · GIF（含动图）· WebP（含动图）· APNG

## 开发

```bash
npm install
npm run tauri dev                    # 开发运行
npm run gen:testdata                 # 生成测试图片到 testdata/
npm run gen:icon && npx tauri icon tools/app-icon.png   # 重新生成图标
npm run tauri build                  # 产出 NSIS 安装包 → src-tauri/target/release/bundle/nsis/
```

环境要求：Node 18+、Rust (stable-msvc)、Visual Studio C++ 工具（CMake 用 VS 自带的即可）。
turbojpeg 已禁用 `require-simd` 特性，无需 NASM。

> ⚠️ 构建发布版必须用 `npm run tauri build`。裸 `cargo build --release`
> 缺 `custom-protocol` 特性，产物启动时会去加载 dev 地址（localhost:1420），
> 没有开发服务器在跑就是空白窗口。

## 技术要点

- Tauri 2 + 系统 WebView2 渲染（GPU 合成），前端无框架
- 图片字节经 Rust `read_image` 命令读取（支持 `\\?\` 长路径），前端转 Blob 解码；
  位图解码失败时自动降级到 `<img>` 通道（可显示任意尺寸），仍失败则显示错误浮层与原因
- 缩略图由 Rust 生成并缓存于 `%LOCALAPPDATA%\com.picaview.app\thumbs`
  （键 = hash(路径+mtime+大小)，文件一变自动失效）
- 内存策略：仅保留当前全图 + 相邻图 tier 位图，其余及时释放
- JPEG 无损旋转后就地修补 EXIF Orientation 字节（复位为 1），不重写整个 EXIF
- 被占用文件替换采用「临时文件 → 重试删除 → 改名」策略
