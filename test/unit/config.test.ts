import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import { encodeJsonEnv } from "../../src/config/env.js";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    FIREBASE_DB_URL: "https://demo.firebaseio.com",
    TARGETS: '[{"provider":"github","repo":"orgA/mono","branch":"main"}]',
  };
}

describe("loadConfig", () => {
  it("requires FIREBASE_DB_URL", () => {
    expect(() => loadConfig({})).toThrowError(/FIREBASE_DB_URL/);
  });

  it("loads targets from raw JSON", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.targets).toHaveLength(1);
    expect(cfg.targets[0].repo).toBe("orgA/mono");
  });

  it("loads targets from base64 JSON", () => {
    const env = baseEnv();
    env.TARGETS = encodeJsonEnv([
      { provider: "azure", repo: "contoso/mirror", branch: "main" },
    ]);
    const cfg = loadConfig(env);
    expect(cfg.targets[0].provider).toBe("azure");
  });

  it("applies sensible defaults", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.sync.mode).toBe("squash");
    expect(cfg.sync.targetConcurrency).toBe(3);
    expect(cfg.sync.cloneDepth).toBe(1);
    expect(cfg.firebase.queuePath).toBe("/sync-queue");
  });

  it("parses exclude/include rules", () => {
    const env = baseEnv();
    env.EXCLUDE_REPOS = '[{"type":"startsWith","value":"test-"}]';
    env.INCLUDE_REPOS = '[{"type":"endsWith","value":"-prod"}]';
    const cfg = loadConfig(env);
    expect(cfg.excludeRepos[0]).toEqual({ type: "startsWith", value: "test-" });
    expect(cfg.includeRepos[0]).toEqual({ type: "endsWith", value: "-prod" });
  });

  it("rejects invalid exclude rule type via zod", () => {
    const env = baseEnv();
    env.EXCLUDE_REPOS = '[{"type":"contains","value":"x"}]';
    expect(() => loadConfig(env)).toThrowError();
  });

  it("unescapes \\n in commit template", () => {
    const env = baseEnv();
    env.COMMIT_MESSAGE_TEMPLATE = "{message}\\nSynced-From: {sourceRepo}";
    const cfg = loadConfig(env);
    expect(cfg.sync.commitMessageTemplate).toContain("\n");
  });
});
