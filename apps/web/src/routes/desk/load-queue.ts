// F5 — serialized, latest-wins job queue for take loads. The player can
// only decode one take at a time; a load requested while another is in
// flight used to be dropped on the floor (player.load's `loading` guard),
// stranding the transport on the stale take. The queue keeps exactly one
// pending request — the LATEST — and runs it when the in-flight load
// settles, so the player always converges to the most recent selection.

export class LoadQueue<T> {
  private inFlight = false;
  private pending: T | null = null;
  private readonly run: (req: T, superseded: () => boolean) => Promise<void>;
  private readonly onError: (error: unknown, req: T) => void;
  private readonly onDropped: (req: T) => void;

  constructor(
    run: (req: T, superseded: () => boolean) => Promise<void>,
    onError: (error: unknown, req: T) => void = () => {},
    // A replaced PENDING request never runs (latest wins) — callers that
    // await a settle signal (the W7-A align flow) must hear about the
    // drop or they would wait forever.
    onDropped: (req: T) => void = () => {},
  ) {
    this.run = run;
    this.onError = onError;
    this.onDropped = onDropped;
  }

  /** Enqueue a request. Runs immediately when idle; otherwise replaces any
   * queued request (latest wins, the replaced one reported dropped) and
   * runs after the in-flight one. */
  request(req: T): void {
    if (this.inFlight) {
      const replaced = this.pending;
      this.pending = req;
      if (replaced !== null) this.onDropped(replaced);
      return;
    }
    void this.drain(req);
  }

  /** True while a load is running or queued. */
  get busy(): boolean {
    return this.inFlight;
  }

  private async drain(first: T): Promise<void> {
    this.inFlight = true;
    try {
      let current: T | null = first;
      while (current !== null) {
        const req = current;
        try {
          // `superseded` lets the job skip follow-up work (e.g. alignment)
          // when a newer request is already waiting to replace its result.
          await this.run(req, () => this.pending !== null);
        } catch (error) {
          // A failed load must never wedge the queue: report and move on
          // to whatever is pending (or stop).
          this.onError(error, req);
        }
        current = this.pending;
        this.pending = null;
      }
    } finally {
      this.inFlight = false;
    }
  }
}
