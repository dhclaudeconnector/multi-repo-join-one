import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { MemoryQueueBackend } from "../../src/queue/memory.js";
import { createSyncService } from "../../src/index.js";
import {
  mkTmp,
  rmTmp,
  seededBareRepo,
  emptyBareRepo,
  makeConfig,
  githubPayload,
  checkout,
} from "./helpers.js";

let tmp: string;
afterEach(async () => {
  if (tmp) await rmTmp(tmp);
});

describe("idempotency", () => {
  it("re-running the same delivery+sha+target creates no duplicate commit", async () => {
    tmp = await mkTmp();
    const src = await seededBareRepo(tmp, "svc1", { "app.js": "// v1\n" });
    const target = await emptyBareRepo(tmp, "mono");

    const backend = new MemoryQueueBackend();
    const config = makeConfig(path.join(tmp, "work"), [
      { provider: "github", repo: target, branch: "main" },
    ]);
    const svc = await createSyncService({ config, backend, silent: true });

    const key = await backend.push(githubPayload(src.bareUrl, src.sha, "svc1", "sync me"));
    await svc.drainAll();
    expect((await backend.get(key))?.status).toBe("done");

    // Force the item back to pending and drain again — targets are already
    // 'done' so the worker skips them (idempotent); and even if it re-copied,
    // there are no content changes so no new commit is produced.
    await backend.setStatus(key, "pending");
    await svc.drainAll();

    const { git } = await checkout(tmp, target, "verify");
    const log = await git.raw(["log", "--pretty=%s", "-n", "20"]);
    const count = (log.match(/^sync me$/gm) ?? []).length;
    expect(count).toBe(1);
    await svc.stop();
  });

  it("skips a push whose repo matches an exclude rule", async () => {
    tmp = await mkTmp();
    const src = await seededBareRepo(tmp, "test-thing", { "x.js": "1\n" });
    const target = await emptyBareRepo(tmp, "mono");

    const backend = new MemoryQueueBackend();
    const config = makeConfig(path.join(tmp, "work"), [
      { provider: "github", repo: target, branch: "main" },
    ]);
    config.excludeRepos = [{ type: "startsWith", value: "test-" }];
    const svc = await createSyncService({ config, backend, silent: true });

    const key = await backend.push(githubPayload(src.bareUrl, src.sha, "test-thing"));
    await svc.drainAll();

    const item = await backend.get(key);
    expect(item?.status).toBe("skipped");
    expect(item?.reason).toMatch(/excluded/);
    await svc.stop();
  });
});
