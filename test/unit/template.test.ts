import { describe, it, expect } from "vitest";
import { renderCommitMessage, shortSha } from "../../src/sync/template.js";
import { DEFAULT_COMMIT_TEMPLATE } from "../../src/config/config.js";
import type { NormalizedPush } from "../../src/types.js";

const push: NormalizedPush = {
  provider: "github",
  org: "orgA",
  repo: "svc1",
  fullName: "orgA/svc1",
  ref: "refs/heads/main",
  branch: "main",
  beforeSha: "a".repeat(40),
  afterSha: "3f2c0000000000000000000000000000000000bb",
  cloneUrl: "https://github.com/orgA/svc1.git",
  pusher: { name: "alice", email: "alice@orgA.com" },
  headCommit: {
    message: "feat: add login",
    author: { name: "Alice", email: "author@orgA.com" },
  },
  deliveryId: "d1",
  raw: {},
};

describe("renderCommitMessage", () => {
  it("shortens sha to 7 chars", () => {
    expect(shortSha(push.afterSha)).toBe("3f2c000");
  });

  it("renders all default-template variables", () => {
    const out = renderCommitMessage(DEFAULT_COMMIT_TEMPLATE, push);
    expect(out).toContain("feat: add login");
    expect(out).toContain("Synced-From: orgA/svc1@3f2c000");
    expect(out).toContain("Provider: github");
    expect(out).toContain("Pushed-By: alice <alice@orgA.com>");
    expect(out).toContain("Original-Author: Alice <author@orgA.com>");
    expect(out).toContain("Ref: refs/heads/main");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(renderCommitMessage("{message} {unknown}", push)).toBe("feat: add login {unknown}");
  });

  it("supports custom template with branch/org/repo", () => {
    const out = renderCommitMessage("[{org}/{repo}@{branch}] {message}", push);
    expect(out).toBe("[orgA/svc1@main] feat: add login");
  });
});
