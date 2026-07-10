// Serialized, latest-wins job queue for take loads: the player decodes one
// take at a time, so exactly one pending request (the latest) is kept and
// runs when the in-flight load settles.

export class LoadQueue<T> {
  private inFlight = false;
  private pending: T | null = null;
  private readonly run: (req: T, superseded: () => boolean) => Promise<void>;
  private readonly onError: (error: unknown, req: T) => void;
  private readonly onDropped: (req: T) => void;

  constructor(
    run: (req: T, superseded: () => boolean) => Promise<void>,
    onError: (error: unknown, req: T) => void = () => {},
    // A replaced PENDING request never runs — callers awaiting a settle
    // signal must hear about the drop or they would wait forever.
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
          // A failed load must never wedge the queue: report and move on.
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
