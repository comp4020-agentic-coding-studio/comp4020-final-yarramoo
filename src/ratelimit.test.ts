import { describe, expect, it } from "vitest";
import { createLimiter } from "./ratelimit.ts";

describe("the fixed-window limiter", () => {
  it("allows the limit, refuses the next hit, and says when to retry", () => {
    const l = createLimiter(3, 1000);
    for (let i = 0; i < 3; i++) expect(l.hit("a", 100 + i).ok).toBe(true);
    const r = l.hit("a", 500);
    expect(r.ok).toBe(false);
    expect(r.retryAfterMs).toBe(600); // window opened at 100, closes at 1100
  });

  it("opens a fresh window once the old one has elapsed", () => {
    const l = createLimiter(1, 1000);
    expect(l.hit("a", 0).ok).toBe(true);
    expect(l.hit("a", 999).ok).toBe(false);
    expect(l.hit("a", 1000).ok).toBe(true);
  });

  it("counts keys separately", () => {
    const l = createLimiter(1, 1000);
    expect(l.hit("a", 0).ok).toBe(true);
    expect(l.hit("b", 0).ok).toBe(true);
    expect(l.hit("a", 1).ok).toBe(false);
  });

  it("a refused hit does not extend the window", () => {
    const l = createLimiter(1, 1000);
    l.hit("a", 0);
    for (let t = 1; t < 1000; t += 100) l.hit("a", t);
    expect(l.hit("a", 1000).ok).toBe(true);
  });

  it("blocked() peeks without counting", () => {
    const l = createLimiter(2, 1000);
    expect(l.blocked("a", 0).blocked).toBe(false);
    expect(l.blocked("a", 0).blocked).toBe(false);
    l.hit("a", 0);
    expect(l.blocked("a", 1).blocked).toBe(false);
    l.hit("a", 2);
    expect(l.blocked("a", 3)).toEqual({ blocked: true, retryAfterMs: 997 });
    expect(l.blocked("a", 1000).blocked).toBe(false);
  });

  it("forgets expired keys, so a flood of one-off keys does not grow without bound", () => {
    const l = createLimiter(1, 1000);
    for (let i = 0; i < 500; i++) l.hit(`ip${i}`, 0);
    expect(l.size()).toBe(500);
    l.hit("late", 5000);
    expect(l.size()).toBe(1);
  });
});
