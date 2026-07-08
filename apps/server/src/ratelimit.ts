// Token buckets backing the RFC §12 MUSTs: per-IP join rate limiting and
// the per-connection signaling message flood guard.

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private tokens: number;
  private refilledAt: number;

  constructor(capacity: number, refillPerSec: number, now = Date.now()) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.refilledAt = now;
  }

  take(now = Date.now()): boolean {
    this.refill(now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  isFull(now = Date.now()): boolean {
    this.refill(now);
    return this.tokens >= this.capacity;
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.refilledAt);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1_000) * this.refillPerSec);
    this.refilledAt = now;
  }
}

/** Per-key (per-IP) buckets; stale full buckets are pruned lazily so the
 * map cannot grow without bound under address churn. */
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly capacity: number;
  private readonly refillPerSec: number;

  constructor(capacity: number, refillPerSec: number) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
  }

  allow(key: string, now = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= 10_000) this.prune(now);
      bucket = new TokenBucket(this.capacity, this.refillPerSec, now);
      this.buckets.set(key, bucket);
    }
    return bucket.take(now);
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.isFull(now)) this.buckets.delete(key);
    }
  }
}
