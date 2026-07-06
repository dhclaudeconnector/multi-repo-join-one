import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { simpleGit } from "simple-git";
import { createSilentLogger } from "../../src/logger.js";
import { shallowCloneSource, type SyncEngineConfig } from "../../src/sync/git.js";
import type { NormalizedPush } from "../../src/types.js";
import { mkTmp, rmTmp, seededBareRepo } from "./helpers.js";

let tmp: string;
afterEach(async () => {
  if (tmp) await rmTmp(tmp);
});

function cfg(workDir: string): SyncEngineConfig {
  return {
    workDir,
    cloneDepth: 1,
    cloneMaxRetries: 3,
    cloneRetryBackoffMs: 20,
    commitMessageTemplate: "{message}",
    env: process.env,
    syncMode: "squash",
  };
}

function pushFor(cloneUrl: string, sha: string): NormalizedPush {
  return {
    provider: "github",
    org: "orgA",
    repo: "svc1",
    fullName: "orgA/svc1",
    ref: "refs/heads/main",
    branch: "main",
    beforeSha: "0".repeat(40),
    afterSha: sha,
    cloneUrl,
    pusher: { name: "a", email: "a@x" },
    headCommit: { message: "m", author: { name: "a", email: "a@x" } },
    deliveryId: "d",
    raw: {},
  };
}

describe("shallow clone + fallback + retry", () => {
  it("clones a source at the exact SHA (depth=1) and checks out its content", async () => {
    tmp = await mkTmp();
    const src = await seededBareRepo(tmp, "svc1", { "hello.txt": "world\n" });
    const dest = path.join(tmp, "clone");

    const { reclones } = await shallowCloneSource(
      pushFor(src.bareUrl, src.sha),
      dest,
      src.bareUrl,
      cfg(path.join(tmp, "work")),
      createSilentLogger()
    );

    expect(reclones).toBe(0);
    const content = await fs.readFile(path.join(dest, "hello.txt"), "utf8");
    expect(content).toBe("world\n");
    const head = (await simpleGit(dest).revparse(["HEAD"])).trim();
    expect(head).toBe(src.sha);
  });

  it("retries and eventually fails on an unreachable remote", async () => {
    tmp = await mkTmp();
    const dest = path.join(tmp, "clone");
    const missing = path.join(tmp, "nope.git");

    await expect(
      shallowCloneSource(
        pushFor(missing, "a".repeat(40)),
        dest,
        missing,
        cfg(path.join(tmp, "work")),
        createSilentLogger()
      )
    ).rejects.toBeTruthy();
  });
});
