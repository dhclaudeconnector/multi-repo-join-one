import { describe, it, expect } from "vitest";
import {
  buildPipeline,
  runPipeline,
  validateHookShape,
  makeRepoNameValidator,
} from "../../src/validators/index.js";
import type { NormalizedPush } from "../../src/types.js";

function push(overrides: Partial<NormalizedPush> = {}): NormalizedPush {
  return {
    provider: "github",
    org: "orgA",
    repo: "svc1",
    fullName: "orgA/svc1",
    ref: "refs/heads/main",
    branch: "main",
    beforeSha: "a".repeat(40),
    afterSha: "b".repeat(40),
    cloneUrl: "https://github.com/orgA/svc1.git",
    pusher: { name: "alice", email: "a@x.com" },
    headCommit: { message: "m", author: { name: "Alice", email: "a@x.com" } },
    deliveryId: "d1",
    raw: {},
    ...overrides,
  };
}

describe("validateHookShape", () => {
  it("passes a complete push", () => {
    expect(validateHookShape(push()).ok).toBe(true);
  });
  it("fails when missing afterSha", () => {
    const r = validateHookShape(push({ afterSha: "" }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/afterSha/);
  });
  it("lists all missing fields", () => {
    const r = validateHookShape(push({ repo: "", ref: "", cloneUrl: "" }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/repo/);
    expect(r.reason).toMatch(/ref/);
    expect(r.reason).toMatch(/cloneUrl/);
  });
});

describe("repo name rules", () => {
  it("startsWith excludes", () => {
    const v = makeRepoNameValidator({ exclude: [{ type: "startsWith", value: "test-" }] });
    expect(v(push({ repo: "test-x", fullName: "orgA/test-x" })).ok).toBe(false);
    expect(v(push({ repo: "svc1" })).ok).toBe(true);
  });

  it("endsWith excludes", () => {
    const v = makeRepoNameValidator({ exclude: [{ type: "endsWith", value: "-sandbox" }] });
    expect(v(push({ repo: "app-sandbox", fullName: "orgA/app-sandbox" })).ok).toBe(false);
    expect(v(push({ repo: "app" })).ok).toBe(true);
  });

  it("equal excludes on full name", () => {
    const v = makeRepoNameValidator({ exclude: [{ type: "equal", value: "orgA/playground" }] });
    expect(v(push({ repo: "playground", fullName: "orgA/playground" })).ok).toBe(false);
    expect(v(push({ repo: "playground", fullName: "orgB/playground" })).ok).toBe(true);
  });

  it("include allowlist blocks non-matching repos", () => {
    const v = makeRepoNameValidator({ include: [{ type: "startsWith", value: "svc" }] });
    expect(v(push({ repo: "svc1" })).ok).toBe(true);
    expect(v(push({ repo: "web" })).ok).toBe(false);
  });

  it("exclude wins over include", () => {
    const v = makeRepoNameValidator({
      include: [{ type: "startsWith", value: "svc" }],
      exclude: [{ type: "equal", value: "svc-secret" }],
    });
    expect(v(push({ repo: "svc-secret", fullName: "orgA/svc-secret" })).ok).toBe(false);
  });
});

describe("pipeline ordering", () => {
  it("short-circuits at first failure", () => {
    const pipeline = buildPipeline({ exclude: [{ type: "startsWith", value: "svc" }] });
    // shape ok but repo excluded
    const r = runPipeline(pipeline, push());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/excluded/);
  });

  it("passes when nothing matches", () => {
    const pipeline = buildPipeline({ exclude: [{ type: "startsWith", value: "zzz" }] });
    expect(runPipeline(pipeline, push()).ok).toBe(true);
  });

  it("supports extra validators", () => {
    const pipeline = buildPipeline({
      extra: [(p) => (p.branch === "main" ? { ok: true } : { ok: false, reason: "not main" })],
    });
    expect(runPipeline(pipeline, push({ branch: "dev" })).ok).toBe(false);
    expect(runPipeline(pipeline, push({ branch: "main" })).ok).toBe(true);
  });
});
