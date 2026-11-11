/**
 * Tiny in-memory leaky bucket. Per-key rate limiting; resets on process restart.
 * Good enough for single-user / household self-hosted use.
 *
 * Imported by middleware.ts, which runs in the Edge runtime: plain `Map`,
 * `Date.now` and math only — no Node APIs, no timers.
 *
 * Memory is bounded even though unauthenticated callers choose the keys:
 * - A bucket that has refilled to full carries no state (a missing key IS a
 *   full bucket), so full buckets are never stored and a periodic sweep drops
 *   the ones that have refilled since. This changes no limiting decision.
 * - At most MAX_BUCKETS keys are kept. Evicting a bucket resets its key to
 *   full, i.e. hands that key `capacity - tokens` extra requests, so eviction
 *   goes smallest relative deficit (`(capacity - tokens) / capacity`) first,
 *   i.e. closest to full, and among equals least recently used first. A
 *   throttled key is evicted only once every other kept bucket is at least
 *   as throttled.
 */

type Bucket = {
  tokens: number;
  lastRefillMs: number;
  capacity: number;
  refillPerSecond: number;
};

export type RateLimitOptions = {
  capacity: number;
  refillPerSecond: number;
};

/** CLAUDE.md §8: a burst of 5, then 5 attempts per 15 minutes per IP. */
export const LOGIN_RATE_LIMIT: RateLimitOptions = {
  capacity: 5,
  refillPerSecond: 5 / (15 * 60),
};

export const MAX_BUCKETS = 10_000;
/** On overflow, evict down to this many so the sort cost is amortized. */
const EVICT_TO = Math.floor(MAX_BUCKETS * 0.9);
const SWEEP_INTERVAL_MS = 60_000;

// Map iteration order is insertion order; takeToken re-inserts a key on every
// use, so the first entries are the least recently used.
const buckets = new Map<string, Bucket>();
let lastSweepMs = 0;

function tokensAt(bucket: Bucket, now: number, opts: RateLimitOptions): number {
  const elapsedSec = (now - bucket.lastRefillMs) / 1000;
  return Math.min(opts.capacity, bucket.tokens + elapsedSec * opts.refillPerSecond);
}

function sweepFull(now: number): void {
  lastSweepMs = now;
  for (const [key, bucket] of buckets) {
    if (tokensAt(bucket, now, bucket) >= bucket.capacity) buckets.delete(key);
  }
}

function evictForInsert(now: number): void {
  sweepFull(now);
  if (buckets.size < MAX_BUCKETS) return;
  // Relative deficit, so limiters with different capacities compare fairly:
  // 6 of 30 used (0.2) goes before 5 of 5 used (1.0).
  const byDeficit = [...buckets].map(([key, bucket]) => ({
    key,
    deficit: (bucket.capacity - tokensAt(bucket, now, bucket)) / bucket.capacity,
  }));
  // Array.prototype.sort is stable, so equal deficits keep LRU order.
  byDeficit.sort((a, b) => a.deficit - b.deficit);
  for (const { key } of byDeficit.slice(0, buckets.size - EVICT_TO)) buckets.delete(key);
}

export function takeToken(key: string, opts: RateLimitOptions): boolean {
  const now = Date.now();
  if (now - lastSweepMs >= SWEEP_INTERVAL_MS) sweepFull(now);

  const existing = buckets.get(key);
  const bucket: Bucket = {
    tokens: existing ? tokensAt(existing, now, opts) : opts.capacity,
    lastRefillMs: now,
    capacity: opts.capacity,
    refillPerSecond: opts.refillPerSecond,
  };
  const ok = bucket.tokens >= 1;
  if (ok) bucket.tokens -= 1;

  if (existing) buckets.delete(key); // re-inserted below as most recently used
  if (bucket.tokens >= opts.capacity) return ok; // full == absent
  if (!existing && buckets.size >= MAX_BUCKETS) evictForInsert(now);
  buckets.set(key, bucket);
  return ok;
}

/**
 * Whole seconds until `key` has one token again (0 when it has one now).
 * Read-only; gives a truthful `retry-after` after takeToken refused.
 */
export function secondsUntilToken(key: string, opts: RateLimitOptions): number {
  const bucket = buckets.get(key);
  if (!bucket) return 0;
  const tokens = tokensAt(bucket, Date.now(), opts);
  if (tokens >= 1) return 0;
  return Math.ceil((1 - tokens) / opts.refillPerSecond);
}

/** Test-only: number of buckets currently held in memory. */
export function bucketCountForTests(): number {
  return buckets.size;
}

/** Test-only: forget every bucket. */
export function resetBucketsForTests(): void {
  buckets.clear();
  lastSweepMs = 0;
}
