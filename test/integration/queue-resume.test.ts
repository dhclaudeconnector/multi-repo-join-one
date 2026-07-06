import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { MemoryQueueBackend } from "../../src/queue/memory.js";
import { createSyncService } from "../../src/index.js";
import {
  mkTmp,
  rmTmp,
  seededBareRepo,
  commitAndPush,
  emptyBareRepo,
  makeConfig,
  githubPayload,
  checkout,
} from "./helpers.js";

let tmp: string;
afterEach(async () => {
  if (tmp) await rmTmp(tmp);
});

describe("FIFO ordering & durability", () => {
  it("processes events in push-key order", async () => {
    tmp = await mkTmp();
    const src = await seededBareRepo(tmp, "svc1", { "seq.txt": "0\n" });
    const target = await emptyBareRepo(tmp, "mono");

    const backend = new MemoryQueueBackend();
    const config = makeConfig(path.join(tmp, "work"), [
      { provider: "github", repo: target, branch: "main" },
    ]);
    const svc = await createSyncService({ config, backend, silent: true });

    // three sequential commits on the source, pushed in order
    const sha1 = src.sha;
    const sha2 = await commitAndPush(src.seedDir, "seq.txt", "1\n", "commit 2");
    const sha3 = await commitAndPush(src.seedDir, "seq.txt", "2\n", "commit 3");

    const k1 = await backend.push(githubPayload(src.bareUrl, sha1, "svc1", "m1"));
    const k2 = await backend.push(githubPayload(src.bareUrl, sha2, "svc1", "m2"));
    const k3 = await backend.push(githubPayload(src.bareUrl, sha3, "svc1", "m3"));
    expect(k1 < k2 && k2 < k3).toBe(true);

    await svc.drainAll();

    // Target history should reflect m1 -> m2 -> m3 in that order.
    const { git } = await checkout(tmp, target, "verify");
    const log = await git.raw(["log", "--pretty=%s", "-n", "10"]);
    const subjects = log.split("\n").map((s) => s.trim()).filter(Boolean);
    const i1 = subjects.indexOf("m1");
    const i2 = subjects.indexOf("m2");
    const i3 = subjects.indexOf("m3");
    // more recent commits appear first in git log
    expect(i3).toBeGreaterThanOrEqual(0);
    expect(i3 < i2 && i2 < i1).toBe(true);
    await svc.stop();
  });

  it("resumes after a simulated crash without loss, dup, or reorder", async () => {
    tmp = await mkTmp();
    const src = await seededBareRepo(tmp, "svc1", { "f.txt": "a\n" });
    const target = await emptyBareRepo(tmp, "mono");
    const shaB = await commitAndPush(src.seedDir, "f.txt", "b\n", "mB");

    // Shared backend simulates the durable RTDB queue across "restarts".
    const backend = new MemoryQueueBackend();
    const config = makeConfig(path.join(tmp, "work"), [
      { provider: "github", repo: target, branch: "main" },
    ]);

    const k1 = await backend.push(githubPayload(src.bareUrl, src.sha, "svc1", "mA"));
    await backend.push(githubPayload(src.bareUrl, shaB, "svc1", "mB"));

    // First "process": handle only the first event, then simulate a crash by
    // leaving the second pending and marking the first as processing mid-way.
    const svc1 = await createSyncService({ config, backend, silent: true });
    await svc1.worker.drainOnce(); // processes k1 fully -> done
    // Simulate crash: force the (already-done) k1 to look 'processing'
    await backend.setStatus(k1, "processing");
    await svc1.stop();

    // Restart: resume() must reset the stuck 'processing' back to pending,
    // but idempotency (targets already done) prevents duplicate commits.
    const svc2 = await createSyncService({ config, backend, silent: true });
    const reset = await svc2.resume();
    expect(reset).toBeGreaterThanOrEqual(1);
    await svc2.drainAll();

    const items = await backend.listAll();
    expect(items.every((i) => i.status === "done")).toBe(true);

    // Verify no duplicate mA commits landed in the target.
    const { git } = await checkout(tmp, target, "verify");
    const log = await git.raw(["log", "--pretty=%s", "-n", "20"]);
    const mACount = (log.match(/^mA$/gm) ?? []).length;
    expect(mACount).toBe(1);
    await svc2.stop();
  });
});
