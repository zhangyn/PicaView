// 带并发上限与优先级的任务队列：等待中的任务可取消，运行中的任务由任务自己判断是否过期

export class TaskQueue {
  private waiting = new Map<string, { run: () => Promise<unknown>; seq: number }>();
  private running = new Set<string>();
  private seq = 0;

  /**
   * @param limit 最大并发
   * @param priorityOf 取任务优先级（越小越先），在每次出队时计算，因此"距当前图的距离"可随翻页实时变化；
   *                   缺省时按入队顺序（FIFO）
   */
  constructor(
    private limit: number,
    private priorityOf: (key: string) => number = () => 0,
  ) {}

  /** 入队；同 key 已在等待或运行中则忽略。返回是否实际入队 */
  push(key: string, run: () => Promise<unknown>): boolean {
    if (this.waiting.has(key) || this.running.has(key)) return false;
    this.waiting.set(key, { run, seq: this.seq++ });
    this.pump();
    return true;
  }

  /** 取消仍在等待的任务（运行中的无法中止） */
  cancel(key: string): void {
    this.waiting.delete(key);
  }

  /** 清空所有等待中的任务 */
  clear(): void {
    this.waiting.clear();
  }

  private pump(): void {
    while (this.running.size < this.limit && this.waiting.size > 0) {
      let bestKey: string | null = null;
      let bestPri = Infinity;
      let bestSeq = Infinity;
      for (const [k, job] of this.waiting) {
        const pri = this.priorityOf(k);
        if (pri < bestPri || (pri === bestPri && job.seq < bestSeq)) {
          bestKey = k;
          bestPri = pri;
          bestSeq = job.seq;
        }
      }
      if (bestKey === null) return;
      const job = this.waiting.get(bestKey)!;
      this.waiting.delete(bestKey);
      this.running.add(bestKey);
      const key = bestKey;
      void job.run()
        .catch(() => {})
        .finally(() => {
          this.running.delete(key);
          this.pump();
        });
    }
  }
}
