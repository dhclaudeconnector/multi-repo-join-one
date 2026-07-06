import { describe, it, expect } from "vitest";
import { generatePushId } from "../../src/queue/pushId.js";

describe("generatePushId", () => {
  it("produces 20-char ids", () => {
    expect(generatePushId()).toHaveLength(20);
  });

  it("is lexicographically ordered by time", () => {
    const a = generatePushId(1000);
    const b = generatePushId(2000);
    const c = generatePushId(3000);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it("preserves order within the same millisecond", () => {
    const ids = Array.from({ length: 50 }, () => generatePushId(5000));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    // all unique
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("generates unique ids across time", () => {
    const ids = new Set<string>();
    let t = Date.now();
    for (let i = 0; i < 500; i++) ids.add(generatePushId(t++));
    expect(ids.size).toBe(500);
  });
});
