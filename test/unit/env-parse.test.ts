import { describe, it, expect } from "vitest";
import { parseJsonEnv, encodeJsonEnv, EnvParseError } from "../../src/config/env.js";

describe("parseJsonEnv", () => {
  it("parses valid raw JSON", () => {
    const v = parseJsonEnv<number[]>("X", '[1,2,3]');
    expect(v).toEqual([1, 2, 3]);
  });

  it("parses valid base64-encoded JSON", () => {
    const obj = [{ provider: "github", repo: "orgA/mono", branch: "main" }];
    const b64 = encodeJsonEnv(obj);
    const v = parseJsonEnv("TARGETS", b64);
    expect(v).toEqual(obj);
  });

  it("prefers raw JSON when value starts with [ or {", () => {
    const v = parseJsonEnv<{ a: number }>("Y", '{"a":1}');
    expect(v).toEqual({ a: 1 });
  });

  it("recovers a shell-mangled base64 value that raw-parse cannot", () => {
    // A JSON object with newline/quotes, encoded to base64, survives shells.
    const obj = { key: "value with spaces\nand newline", nested: { x: [1, 2] } };
    const b64 = encodeJsonEnv(obj);
    expect(parseJsonEnv("Z", b64)).toEqual(obj);
  });

  it("returns fallback for empty/unset value", () => {
    expect(parseJsonEnv("EMPTY", "", [])).toEqual([]);
    expect(parseJsonEnv("EMPTY", undefined, { d: 1 })).toEqual({ d: 1 });
  });

  it("throws EnvParseError with the var name for total garbage", () => {
    expect(() => parseJsonEnv("BROKEN", "this is not json at all {{{"))
      .toThrowError(/BROKEN/);
    try {
      parseJsonEnv("BROKEN", "not json");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvParseError);
    }
  });

  it("throws when empty and no fallback", () => {
    expect(() => parseJsonEnv("MISSING", "")).toThrowError(/MISSING/);
  });

  it("reads from process.env when rawValue omitted", () => {
    process.env.__TEST_JSON_ENV = '{"ok":true}';
    expect(parseJsonEnv("__TEST_JSON_ENV")).toEqual({ ok: true });
    delete process.env.__TEST_JSON_ENV;
  });
});
