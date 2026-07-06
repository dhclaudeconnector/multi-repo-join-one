import { describe, it, expect } from "vitest";
import {
  resolveToken,
  authenticateUrl,
  normalizeSegment,
} from "../../src/config/tokens.js";

describe("token resolver fallback", () => {
  const base: NodeJS.ProcessEnv = {
    TOKEN__DEFAULT: "default_tok",
    TOKEN__GITHUB: "gh_global",
    TOKEN__GITHUB__ORGA: "gh_orgA",
    TOKEN__GITHUB__ORGA__SVC1: "gh_svc1",
  };

  it("hits repo-specific first", () => {
    const r = resolveToken(base, "github", "orgA", "svc1");
    expect(r?.token).toBe("gh_svc1");
    expect(r?.level).toBe("repo");
  });

  it("falls back to org", () => {
    const r = resolveToken(base, "github", "orgA", "other");
    expect(r?.token).toBe("gh_orgA");
    expect(r?.level).toBe("org");
  });

  it("falls back to global provider token", () => {
    const r = resolveToken(base, "github", "orgB", "x");
    expect(r?.token).toBe("gh_global");
    expect(r?.level).toBe("global");
  });

  it("falls back to default when provider unknown", () => {
    const r = resolveToken(base, "azure", "contoso", "y");
    expect(r?.token).toBe("default_tok");
    expect(r?.level).toBe("default");
  });

  it("returns null when nothing matches", () => {
    const r = resolveToken({}, "github", "orgA", "svc1");
    expect(r).toBeNull();
  });

  it("normalizes segments with special chars", () => {
    expect(normalizeSegment("svc-1")).toBe("SVC_1");
    expect(normalizeSegment("orgA")).toBe("ORGA");
    expect(normalizeSegment("my.repo")).toBe("MY_REPO");
  });

  it("matches repo names with dashes via normalized keys", () => {
    const env = { "TOKEN__GITHUB__ORG_X__MY_REPO": "tok" };
    const r = resolveToken(env, "github", "org-x", "my-repo");
    expect(r?.token).toBe("tok");
    expect(r?.level).toBe("repo");
  });
});

describe("authenticateUrl", () => {
  it("injects github token as x-access-token", () => {
    const u = authenticateUrl("https://github.com/orgA/mono.git", "ghp_x", "github");
    expect(u).toContain("x-access-token");
    expect(u).toContain("ghp_x");
  });

  it("injects azure token as pat password", () => {
    const u = authenticateUrl("https://dev.azure.com/contoso/_git/mirror", "azp", "azure");
    expect(u).toContain("pat");
    expect(u).toContain("azp");
  });

  it("leaves non-http urls (local paths) unchanged", () => {
    expect(authenticateUrl("/tmp/repo.git", "tok", "github")).toBe("/tmp/repo.git");
  });
});
