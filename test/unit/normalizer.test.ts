import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { normalize, detectProvider, normalizeGithub, normalizeAzure } from "../../src/providers/index.js";

const fixtures = path.resolve(process.cwd(), "test/fixtures");
const gh = JSON.parse(readFileSync(path.join(fixtures, "github-push.json"), "utf8"));
const az = JSON.parse(readFileSync(path.join(fixtures, "azure-push.json"), "utf8"));
const ghBad = JSON.parse(readFileSync(path.join(fixtures, "github-push-invalid.json"), "utf8"));

describe("provider detection", () => {
  it("detects github", () => expect(detectProvider(gh)).toBe("github"));
  it("detects azure", () => expect(detectProvider(az)).toBe("azure"));
  it("honours explicit _provider", () => {
    expect(detectProvider({ _provider: "azure" })).toBe("azure");
  });
  it("throws on unknown shape", () => {
    expect(() => detectProvider({ foo: "bar" })).toThrowError(/detect/);
  });
});

describe("github normalizer", () => {
  const n = normalizeGithub(gh, "deliv-1");
  it("maps every field", () => {
    expect(n.provider).toBe("github");
    expect(n.org).toBe("orgA");
    expect(n.repo).toBe("svc1");
    expect(n.fullName).toBe("orgA/svc1");
    expect(n.ref).toBe("refs/heads/main");
    expect(n.branch).toBe("main");
    expect(n.afterSha).toBe("3f2c0000000000000000000000000000000000bb");
    expect(n.beforeSha).toBe("9a1b0000000000000000000000000000000000aa");
    expect(n.cloneUrl).toBe("https://github.com/orgA/svc1.git");
    expect(n.pusher).toEqual({ name: "alice", email: "alice@orgA.com" });
    expect(n.headCommit.message).toBe("feat: add login");
    expect(n.headCommit.author).toEqual({ name: "Alice", email: "alice@orgA.com" });
    expect(n.deliveryId).toBe("deliv-1");
  });

  it("throws when after SHA missing", () => {
    expect(() => normalizeGithub(ghBad)).toThrowError();
  });
});

describe("azure normalizer", () => {
  const n = normalizeAzure(az, "deliv-2");
  it("maps every field", () => {
    expect(n.provider).toBe("azure");
    expect(n.org).toBe("contoso");
    expect(n.repo).toBe("mirror");
    expect(n.fullName).toBe("contoso/mirror");
    expect(n.ref).toBe("refs/heads/main");
    expect(n.branch).toBe("main");
    expect(n.afterSha).toBe("3f2c0000000000000000000000000000000000bb");
    expect(n.beforeSha).toBe("9a1b0000000000000000000000000000000000aa");
    expect(n.cloneUrl).toBe("https://dev.azure.com/contoso/_git/mirror");
    expect(n.pusher.name).toBe("Alice");
    expect(n.pusher.email).toBe("alice@contoso.com");
    expect(n.headCommit.message).toBe("feat: add login");
  });

  it("throws when refUpdates missing", () => {
    expect(() => normalizeAzure({ resource: { repository: { name: "x" } } })).toThrowError();
  });
});

describe("normalize() dispatch", () => {
  it("routes github + azure correctly", () => {
    expect(normalize(gh).provider).toBe("github");
    expect(normalize(az).provider).toBe("azure");
  });
  it("throws on unknown payload", () => {
    expect(() => normalize({ nope: true })).toThrowError();
  });
});
