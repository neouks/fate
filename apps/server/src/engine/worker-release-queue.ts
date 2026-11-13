export interface WorkerRelease {
  slot: string;
  taskID: number;
  expID: number;
  intentID: number;
}

/** Only enqueue after the executor has exited. A terminal graph state alone is
 * not permission to free a slot: tools may still be unwinding.
 * The dispatcher retries cleanup, never the model or executed operation. After
 * process loss, existing lease expiry and settlement recovery take over. */
export class WorkerReleaseQueue {
  private pending = new Map<string, { item: WorkerRelease; next: number; reported: boolean; running?: Promise<void> }>();

  constructor(
    private release: (item: WorkerRelease) => Promise<void>,
    private report: (item: WorkerRelease, error: unknown) => void,
    private now = Date.now,
  ) {}

  get size() { return this.pending.size; }

  async finish(item: WorkerRelease) {
    if (!this.pending.has(item.slot)) this.pending.set(item.slot, { item, next: 0, reported: false });
    await this.attempt(item.slot);
  }

  async flush(force = false) {
    // Bound each pass so cleanup cannot starve normal task dispatch.
    const due = [...this.pending].filter(([, entry]) => force || entry.next <= this.now()).slice(0, 32);
    for (const [slot] of due) await this.attempt(slot, force);
  }

  private async attempt(slot: string, force = false): Promise<void> {
    const entry = this.pending.get(slot);
    if (!entry) return;
    if (entry.running) return entry.running;
    if (!force && entry.next > this.now()) return;
    const run = Promise.resolve().then(async () => {
      try {
        await this.release(entry.item);
        this.pending.delete(slot);
      } catch (error) {
        entry.next = this.now() + 1000;
        if (!entry.reported) {
          entry.reported = true;
          this.report(entry.item, error);
        }
      }
    });
    entry.running = run;
    try { await run; } finally { entry.running = undefined; }
  }
}
