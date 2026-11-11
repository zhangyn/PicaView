// 导出 / 另存为：目标格式（含质量）、长边上限、保存位置
//
// 扩展名由后端按实际写入的格式纠正，前端只负责给一个合理的默认名。

import { invoke } from "@tauri-apps/api/core";

import { Modal } from "./modal";
import { showDialog } from "./dialog";
import { baseName, dirname, extOf, humanSize, stemOf, toast } from "./util";

interface ExportResult {
  path: string;
  bytes: number;
  width: number;
  height: number;
  format: string;
}

type ExportFormat = "keep" | "jpeg" | "png" | "webp";

const EXT_FOR: Record<Exclude<ExportFormat, "keep">, string> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
};

export interface ExportSource {
  path: string;
  animated: boolean;
}

export class Exporter {
  private readonly modal: Modal;
  private readonly backdrop = document.getElementById("export-backdrop")!;
  private readonly formatEl = document.getElementById("export-format") as HTMLSelectElement;
  private readonly maxEl = document.getElementById("export-max") as HTMLInputElement;
  private readonly qualityRow = document.getElementById("export-quality-row")!;
  private readonly qualityEl = document.getElementById("export-quality") as HTMLInputElement;
  private readonly qualityVal = document.getElementById("export-quality-val")!;
  private readonly destEl = document.getElementById("export-dest")!;
  private readonly pickBtn = document.getElementById("export-pick") as HTMLButtonElement;
  private readonly okBtn = document.getElementById("export-ok") as HTMLButtonElement;
  private readonly cancelBtn = document.getElementById("export-cancel") as HTMLButtonElement;
  private readonly noteEl = document.getElementById("export-note")!;

  private src: ExportSource | null = null;
  private dest = "";
  private destPicked = false;
  private busy = false;

  constructor(private readonly current: () => ExportSource | null) {
    this.modal = new Modal(this.backdrop, () => this.formatEl);
    this.formatEl.addEventListener("change", () => {
      this.destPicked = false;
      this.syncDeps();
    });
    this.qualityEl.addEventListener("input", () => {
      this.qualityVal.textContent = this.qualityEl.value;
    });
    this.pickBtn.addEventListener("click", () => void this.pickDest());
    this.cancelBtn.addEventListener("click", () => this.modal.close());
    this.okBtn.addEventListener("click", () => void this.run(false));
  }

  open() {
    const cur = this.current();
    if (!cur) {
      toast("没有打开的图片");
      return;
    }
    this.src = cur;
    this.destPicked = false;
    this.formatEl.value = "keep";
    this.maxEl.value = "";
    this.qualityEl.value = "92";
    this.qualityVal.textContent = "92";
    this.syncDeps();
    this.modal.open();
  }

  // ---------- 控件联动 ----------

  private format(): ExportFormat {
    return this.formatEl.value as ExportFormat;
  }

  /** JPEG 目标才需要质量：keep 时看源文件是不是 JPEG */
  private jpegTarget(): boolean {
    const f = this.format();
    if (f === "jpeg") return true;
    if (f === "png" || f === "webp") return false;
    const e = this.src ? extOf(this.src.path) : "";
    return e === "jpg" || e === "jpeg";
  }

  private destExt(): string {
    const f = this.format();
    if (f === "keep") return this.src ? extOf(this.src.path) || "png" : "png";
    return EXT_FOR[f];
  }

  private syncDeps() {
    this.qualityRow.classList.toggle("hidden", !this.jpegTarget());
    const notes: string[] = [];
    if (this.format() === "keep") {
      const e = this.src ? extOf(this.src.path) : "";
      notes.push(e === "bmp" || e === "gif" ? "BMP / GIF 导出为 PNG" : "保持源文件格式");
    }
    if (this.format() === "webp") notes.push("WebP 为无损编码，体积可能较大");
    if (this.src?.animated) notes.push("动图只导出第一帧");
    this.noteEl.textContent = notes.join(" · ");

    if (this.src && !this.destPicked) {
      this.dest = this.defaultDest(this.src.path);
    }
    this.destEl.textContent = this.dest || "—";
    this.destEl.title = this.dest;
  }

  private defaultDest(src: string): string {
    const sep = src.includes("\\") ? "\\" : "/";
    const dir = dirname(src);
    const name = `${stemOf(src) || "导出"}-导出.${this.destExt()}`;
    return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
  }

  private maxSide(): number | undefined {
    const v = Number(this.maxEl.value);
    if (!Number.isFinite(v) || v < 64) return undefined;
    return Math.round(v);
  }

  // ---------- 操作 ----------

  private async pickDest() {
    if (!this.src) return;
    try {
      const picked = await invoke<string | null>("pick_save_path", {
        dir: this.dest ? dirname(this.dest) : dirname(this.src.path),
        fileName: this.dest ? baseName(this.dest) : `${stemOf(this.src.path)}-导出.${this.destExt()}`,
        ext: this.destExt(),
      });
      if (!picked) return;
      this.dest = picked;
      this.destPicked = true;
      this.syncDeps();
    } catch (e) {
      toast(`无法打开保存对话框：${String(e)}`);
    }
  }

  private async run(overwrite: boolean) {
    const cur = this.src;
    if (!cur || this.busy) return;
    if (!this.dest) {
      toast("请先选择保存位置");
      return;
    }
    this.busy = true;
    this.okBtn.disabled = true;
    try {
      const r = await invoke<ExportResult>("export_image", {
        src: cur.path,
        dest: this.dest,
        format: this.format(),
        maxSide: this.maxSide(),
        quality: Number(this.qualityEl.value),
        overwrite,
      });
      toast(`已导出 ${r.format} ${r.width}×${r.height}（${humanSize(r.bytes)}）`);
      this.modal.close();
    } catch (e) {
      const msg = String(e);
      if (!overwrite && msg.includes("已存在")) {
        const ans = await showDialog({
          message: `${baseName(this.dest)} 已存在，覆盖它？`,
          okText: "覆盖",
          danger: true,
        });
        this.busy = false;
        this.okBtn.disabled = false;
        if (ans.ok) await this.run(true);
        return;
      }
      toast(`导出失败：${msg}`);
    } finally {
      this.busy = false;
      this.okBtn.disabled = false;
    }
  }
}
