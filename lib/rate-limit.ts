/**
 * Tiny in-memory leaky bucket. Per-key rate limiting; resets on process restart.
 * Good enough for single-user / household self-hosted use.
 */

type Bucket = { tokens: number; lastRefillMs: number };

const buckets = new Map<string, Bucket>();

export type RateLimitOptions = {
  capacity: number;
  refillPerSecond: number;
};

export function takeToken(key: string, opts: RateLimitOptions): boolean {
  const now = Date.now();
  const existing = buckets.get(key);
  const bucket: Bucket = existing ?? { tokens: opts.capacity, lastRefillMs: now };
  const elapsedSec = (now - bucket.lastRefillMs) / 1000;
  bucket.tokens = Math.min(opts.capacity, bucket.tokens + elapsedSec * opts.refillPerSecond);
  bucket.lastRefillMs = now;
  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return false;
  }
  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return true;
}
