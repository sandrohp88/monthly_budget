import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOGIN_RATE_LIMIT,
  MAX_BUCKETS,
  bucketCountForTests,
  resetBucketsForTests,
  secondsUntilToken,
  takeToken,
} from "./rate-limit";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-10T00:00:00Z"));
  resetBucketsForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetBucketsForTests();
});

describe("login rate limit (CLAUDE.md §8: 5 attempts per 15 minutes per IP)", () => {
  it("accepts a burst of 5, refuses the 6th, then accepts exactly one more after 180 s", () => {
    const key = "login:203.0.113.7";
    for (let i = 0; i < 5; i++) expect(takeToken(key, LOGIN_RATE_LIMIT)).toBe(true);
    expect(takeToken(key, LOGIN_RATE_LIMIT)).toBe(false);
    expect(secondsUntilToken(key, LOGIN_RATE_LIMIT)).toBe(180);

    vi.advanceTimersByTime(179_000);
    expect(takeToken(key, LOGIN_RATE_LIMIT)).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(takeToken(key, LOGIN_RATE_LIMIT)).toBe(true);
    expect(takeToken(key, LOGIN_RATE_LIMIT)).toBe(false);
  });

  it("accepts at most 10 attempts in any 15 minutes from a full bucket", () => {
    const key = "login:203.0.113.8";
    let accepted = 0;
    // One attempt per second for 15 minutes, both ends inclusive.
    for (let s = 0; s <= 15 * 60; s++) {
      if (takeToken(key, LOGIN_RATE_LIMIT)) accepted++;
      vi.advanceTimersByTime(1_000);
    }
    expect(accepted).toBeLessThanOrEqual(10);
    expect(accepted).toBeGreaterThanOrEqual(5);
  });

  it("reports a truthful wait for a partly refilled bucket", () => {
    const key = "login:203.0.113.9";
    for (let i = 0; i < 5; i++) takeToken(key, LOGIN_RATE_LIMIT);
    vi.advanceTimersByTime(100_000);
    expect(takeToken(key, LOGIN_RATE_LIMIT)).toBe(false);
    expect(secondsUntilToken(key, LOGIN_RATE_LIMIT)).toBe(80);
    expect(secondsUntilToken("login:never-seen", LOGIN_RATE_LIMIT)).toBe(0);
  });
});

describe("bucket memory stays bounded", () => {
  const opts = { capacity: 5, refillPerSecond: 1 };

  it("does not retain a bucket once it has refilled to full", () => {
    expect(takeToken("a", opts)).toBe(true);
    expect(bucketCountForTests()).toBe(1);

    // Long enough for "a" to be full again and for the periodic sweep to run.
    vi.advanceTimersByTime(10 * 60_000);
    expect(takeToken("b", opts)).toBe(true);
    expect(bucketCountForTests()).toBe(1);

    // "a" comes back as a fresh full bucket, exactly as if it had been kept.
    for (let i = 0; i < 5; i++) expect(takeToken("a", opts)).toBe(true);
    expect(takeToken("a", opts)).toBe(false);
  });

  it("holds the cap after 50,000 distinct keys", () => {
    for (let i = 0; i < 50_000; i++) {
      takeToken(`login:2001:db8::${i.toString(16)}`, LOGIN_RATE_LIMIT);
      expect(bucketCountForTests()).toBeLessThanOrEqual(MAX_BUCKETS);
    }
    expect(bucketCountForTests()).toBeLessThanOrEqual(MAX_BUCKETS);
  });

  it("keeps a throttled key throttled while other keys are added below the cap", () => {
    const victim = "login:198.51.100.1";
    for (let i = 0; i < 5; i++) takeToken(victim, LOGIN_RATE_LIMIT);
    for (let i = 0; i < MAX_BUCKETS - 10; i++) {
      takeToken(`login:10.0.${i >> 8}.${i & 255}`, LOGIN_RATE_LIMIT);
    }
    vi.advanceTimersByTime(2 * 60_000); // past the sweep interval, under one refill
    takeToken("login:10.255.255.255", LOGIN_RATE_LIMIT);
    expect(takeToken(victim, LOGIN_RATE_LIMIT)).toBe(false);
  });

  it("evicts a nearly full capacity-30 bucket before a drained capacity-5 one", () => {
    const webhook = { capacity: 30, refillPerSecond: 1 };
    const victim = "login:198.51.100.3";
    for (let i = 0; i < 5; i++) takeToken(victim, LOGIN_RATE_LIMIT); // 5 of 5 used
    // Fill to the cap with webhook buckets that used 6 of 30 (deficit 6 > 5).
    for (let i = 0; i < MAX_BUCKETS - 1; i++) {
      for (let t = 0; t < 6; t++) takeToken(`plaid-webhook:10.1.${i >> 8}.${i & 255}`, webhook);
    }
    expect(bucketCountForTests()).toBe(MAX_BUCKETS);
    takeToken("login:new-key", LOGIN_RATE_LIMIT); // overflow -> eviction
    expect(bucketCountForTests()).toBeLessThanOrEqual(MAX_BUCKETS);
    expect(takeToken(victim, LOGIN_RATE_LIMIT)).toBe(false);
  });

  it("evicts nearly-full buckets before a throttled one when the cap overflows", () => {
    const victim = "login:198.51.100.2";
    for (let i = 0; i < 5; i++) takeToken(victim, LOGIN_RATE_LIMIT);
    for (let i = 0; i < 3 * MAX_BUCKETS; i++) {
      takeToken(`login:spray-${i}`, LOGIN_RATE_LIMIT);
    }
    expect(bucketCountForTests()).toBeLessThanOrEqual(MAX_BUCKETS);
    expect(takeToken(victim, LOGIN_RATE_LIMIT)).toBe(false);
  });
});
