import { describe, it, expect } from "vitest";
import { createSilentLogger } from "../../src/logger.js";
import { runSmoke } from "../../src/smoke.js";

describe("smoke (self-contained, both providers)", () => {
  it("passes end-to-end with local bare repos", async () => {
    const result = await runSmoke(createSilentLogger());
    if (!result.ok) {
      // surface details on failure for debugging
      throw new Error("smoke failed:\n" + result.details.join("\n"));
    }
    expect(result.ok).toBe(true);
    expect(result.details.join("\n")).toContain("svc1/app.js");
    expect(result.details.join("\n")).toContain("mirror-src/main.py");
    expect(result.details.join("\n")).toContain("Synced-From");
  });
});
