// 底部缩略图胶片条：IntersectionObserver 懒加载 + 优先级请求队列 + 磁盘缓存（Rust 侧）

import { invoke } from "@tauri-apps/api/core";
import type { ImageEntry } from "./types";
import { TaskQueue } from "./queue";
import {
  THUMB_AROUND_RADIUS, THUMB_CONCURRENCY, THUMB_H, THUMB_MAX_LOADED, THUMB_PREFETCH_MARGIN, THUMB_W,
} from "./config";

interface ThumbNode {
  path: string;
  /** 占位元素（div.thumb）；真正绘制时才往里挂一个 canvas */
  el: HTMLElement;
  /** 在列表中的下标（删除后保持连续） */
  idx: number;
  /** canvas 上已画有缩略图（像素占内存，离开范围会释放） */
  loaded: boolean;
  removed: boolean;
}

export class Filmstrip {
  private root: HTMLElement;
  private strip: HTMLElement;
  private nodes: ThumbNode[] = [];
  private byPath = new Map<string, ThumbNode>();
  private byEl = new Map<Element, ThumbNode>();
  /** IntersectionObserver 判定在（含预取边距的）视口内的路径 */
  private wanted = new Set<string>();
  /** 当前图附近、需要优先加载并保留的路径 */
  private around = new Set<string>();
  private curNode: ThumbNode | null = null;
  private curIdx = 0;
  private loadedCount = 0;
  /** 列表代数：目录切换/重建后，旧请求的结果直接丢弃 */
  private gen = 0;
  /** path → 内容版本：就地改写（旋转）后自增，使在途的缩略图请求作废 */
  private ver = new Map<string, number>();
  private io: IntersectionObserver;
  private queue: TaskQueue;
  visible = true;
  onPick: ((index: number) => void) | null = null;

  constructor() {
    this.root = document.getElementById("filmstrip")!;
    this.strip = document.getElementById("thumbs")!;

    // 按"距当前图的距离"出队，距离在每次出队时实时计算
    this.queue = new TaskQueue(THUMB_CONCURRENCY, (path) => {
      const n = this.byPath.get(path);
      return n ? Math.abs(n.idx - this.curIdx) : Infinity;
    });

    // root 为胶片条容器，水平方向预取约 2 屏；手动滚动同样会触发
    this.io = new IntersectionObserver((es) => this.onIntersect(es), {
      root: this.root,
      rootMargin: `0px ${THUMB_PREFETCH_MARGIN} 0px ${THUMB_PREFETCH_MARGIN}`,
    });

    // 点击用事件委托：删除节点后不必重绑下标
    this.strip.addEventListener("click", (e) => {
      // 命中内层 canvas 时向上找占位 div
      const el = (e.target as Element | null)?.closest?.(".thumb");
      const n = el ? this.byEl.get(el) : undefined;
      if (n) this.onPick?.(n.idx);
    });

    // 纵向滚轮 → 横向滚动（必须非 passive 才能 preventDefault）
    this.root.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // 触摸板横滑本就能滚
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? this.root.clientWidth : 1;
      this.root.scrollLeft += e.deltaY * unit;
    }, { passive: false });
  }

  toggle(): boolean {
    return this.setVisible(!this.visible);
  }

  setVisible(v: boolean): boolean {
    this.visible = v;
    this.root.classList.toggle("hidden", !v);
    document.body.classList.toggle("has-strip", v);
    return v;
  }

  /** 列表整体变化（打开新目录）时重建 DOM */
  rebuild(entries: ImageEntry[], currentPath: string | null) {
    this.gen++;
    this.ver.clear();
    this.io.disconnect();
    this.queue.clear();
    this.strip.textContent = "";
    for (const n of this.nodes) n.removed = true;
    this.nodes = [];
    this.byPath.clear();
    this.byEl.clear();
    this.wanted.clear();
    this.around.clear();
    this.curNode = null;
    this.loadedCount = 0;

    const frag = document.createDocumentFragment();
    entries.forEach((e, i) => {
      // 只建一个轻量占位 div：上万个条目时不再各建一个 canvas（像素与显存都省），
      // canvas 在真正绘制时由 draw() 挂上、release() 摘掉
      const el = document.createElement("div");
      el.className = "thumb";
      el.title = e.name;
      frag.appendChild(el);
      const n: ThumbNode = { path: e.path, el, idx: i, loaded: false, removed: false };
      this.nodes.push(n);
      this.byPath.set(e.path, n);
      this.byEl.set(el, n);
    });
    this.strip.appendChild(frag);
    for (const n of this.nodes) this.io.observe(n.el);
    this.setCurrent(currentPath);
  }

  /** 删除一张：只移除对应节点并更新下标，不重建 */
  remove(path: string) {
    const n = this.byPath.get(path);
    if (!n) return;
    this.io.unobserve(n.el);
    this.queue.cancel(path);
    n.removed = true;
    if (n.loaded) this.loadedCount--;
    n.loaded = false;
    n.el.textContent = ""; // 摘掉 canvas，释放后备存储
    n.el.remove();
    this.nodes.splice(n.idx, 1);
    for (let i = n.idx; i < this.nodes.length; i++) this.nodes[i].idx = i;
    this.byPath.delete(path);
    this.byEl.delete(n.el);
    this.ver.delete(path);
    this.wanted.delete(path);
    this.around.delete(path);
    if (this.curNode === n) this.curNode = null;
  }

  /** 文件内容变化（旋转等）后调用：丢弃旧像素并重新请求（缓存键含 mtime/大小，会重新生成） */
  invalidate(path: string) {
    const n = this.byPath.get(path);
    if (!n) return;
    this.ver.set(path, (this.ver.get(path) ?? 0) + 1); // 作废在途请求
    this.queue.cancel(path);
    if (n.loaded) {
      n.loaded = false;
      this.loadedCount--;
    }
    n.el.textContent = ""; // 摘掉旧像素
    this.enqueue(n);
  }

  /** 请求当前图附近的缩略图（优先加载，并保证不被释放） */
  ensureAround(entries: ImageEntry[], index: number, radius = THUMB_AROUND_RADIUS) {
    this.curIdx = index;
    const lo = Math.max(0, index - radius);
    const hi = Math.min(entries.length - 1, index + radius);
    const next = new Set<string>();
    for (let i = lo; i <= hi; i++) next.add(entries[i].path);
    // 不再属于附近范围、也不在视口内的等待请求：取消
    for (const p of this.around) {
      if (!next.has(p) && !this.wanted.has(p)) this.queue.cancel(p);
    }
    this.around = next;
    for (const p of next) {
      const n = this.byPath.get(p);
      if (n) this.enqueue(n);
    }
  }

  private onIntersect(es: IntersectionObserverEntry[]) {
    for (const e of es) {
      const n = this.byEl.get(e.target);
      if (!n || n.removed) continue;
      if (e.isIntersecting) {
        this.wanted.add(n.path);
        this.enqueue(n);
      } else {
        this.wanted.delete(n.path);
        if (!this.around.has(n.path)) {
          this.queue.cancel(n.path);
          this.maybeRelease(n);
        }
      }
    }
  }

  private isWanted(n: ThumbNode): boolean {
    return !n.removed && (this.wanted.has(n.path) || this.around.has(n.path));
  }

  private enqueue(n: ThumbNode) {
    if (n.loaded || n.removed) return;
    const gen = this.gen;
    const ver = this.ver.get(n.path) ?? 0;
    this.queue.push(n.path, () => this.fetchThumb(n, gen, ver));
  }

  /** 结果是否仍然有效：目录没换、路径没变、内容版本没变、仍需要它 */
  private stillWanted(n: ThumbNode, gen: number, path: string, ver: number): boolean {
    return gen === this.gen && n.path === path && !n.removed &&
      ver === (this.ver.get(path) ?? 0) && this.isWanted(n);
  }

  private async fetchThumb(n: ThumbNode, gen: number, ver: number) {
    // 出队时再确认一次：期间可能已离开视口/被删除/目录已切换/文件已旋转
    if (gen !== this.gen || !this.isWanted(n) || n.loaded) return;
    const path = n.path;
    if (ver !== (this.ver.get(path) ?? 0)) return;
    const buf = await invoke<ArrayBuffer>("thumbnail", { path });
    if (!this.stillWanted(n, gen, path, ver)) return; // 过期：丢弃
    if (buf.byteLength === 0) return;
    const bmp = await createImageBitmap(new Blob([buf], { type: "image/jpeg" }));
    if (!this.stillWanted(n, gen, path, ver)) {
      bmp.close();
      return;
    }
    this.draw(n, bmp);
    bmp.close(); // 画布已持有像素，位图不再需要
    this.trim();
  }

  private draw(n: ThumbNode, bmp: ImageBitmap) {
    let cv = n.el.firstElementChild as HTMLCanvasElement | null;
    if (!cv) {
      cv = document.createElement("canvas");
      n.el.appendChild(cv);
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(THUMB_W * dpr);
    cv.height = Math.round(THUMB_H * dpr);
    const ctx = cv.getContext("2d")!;
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const s = Math.min(w / bmp.width, h / bmp.height);
    ctx.drawImage(bmp, (w - bmp.width * s) / 2, (h - bmp.height * s) / 2,
      bmp.width * s, bmp.height * s);
    if (!n.loaded) {
      n.loaded = true;
      this.loadedCount++;
    }
  }

  /** 释放远离当前图且不在视口内的缩略图像素 */
  private maybeRelease(n: ThumbNode) {
    if (!n.loaded) return;
    if (Math.abs(n.idx - this.curIdx) <= THUMB_AROUND_RADIUS) return;
    this.release(n);
  }

  private release(n: ThumbNode) {
    n.el.textContent = ""; // 摘掉画布即释放后备存储
    n.loaded = false;
    this.loadedCount--;
  }

  /** 已加载数量超限时，从离当前图最远的开始释放（不动视口内/附近的） */
  private trim() {
    if (this.loadedCount <= THUMB_MAX_LOADED) return;
    const cands = this.nodes
      .filter((n) => n.loaded && !this.isWanted(n))
      .sort((a, b) => Math.abs(b.idx - this.curIdx) - Math.abs(a.idx - this.curIdx));
    for (const n of cands) {
      if (this.loadedCount <= THUMB_MAX_LOADED) break;
      this.release(n);
    }
  }

  /** 只更新上一张与当前张的 class，不遍历全部节点 */
  setCurrent(path: string | null) {
    const n = path ? this.byPath.get(path) ?? null : null;
    if (this.curNode && this.curNode !== n) this.curNode.el.classList.remove("current");
    this.curNode = n;
    if (!n) return;
    n.el.classList.add("current");
    this.curIdx = n.idx;
    // 滚动到可见（平滑）
    const left = n.el.offsetLeft - this.root.clientWidth / 2 + n.el.offsetWidth / 2;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.root.scrollTo({ left, behavior: reduce ? "auto" : "smooth" });
  }

  /** 重命名后：换 key，保留已画好的缩略图 */
  rename(oldPath: string, entry: ImageEntry) {
    const n = this.byPath.get(oldPath);
    if (!n) return;
    this.queue.cancel(oldPath);
    this.byPath.delete(oldPath);
    n.path = entry.path;
    n.el.title = entry.name;
    this.byPath.set(entry.path, n);
    if (this.wanted.delete(oldPath)) this.wanted.add(entry.path);
    if (this.around.delete(oldPath)) this.around.add(entry.path);
    this.enqueue(n);
  }
}
