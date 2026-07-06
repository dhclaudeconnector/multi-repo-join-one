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
  readFileSafe,
} from "./helpers.js";

let tmp: string;
afterEach(async () => {
  if (tmp) await rmTmp(tmp);
});

describe("multi-target fan-out", () => {
  it("syncs one source into multiple targets under <repo-name>/", async () => {
    tmp = await mkTmp();
    const src = await seededBareRepo(tmp, "svc1", { "app.js": "// v1\n" });
    const t1 = await emptyBareRepo(tmp, "mono");
    const t2 = await emptyBareRepo(tmp, "backup");

    const backend = new MemoryQueueBackend();
    const config = makeConfig(path.join(tmp, "work"), [
      { provider: "github", repo: t1, branch: "main" },
      { provider: "github", repo: t2, branch: "main" },
    ]);
    const svc = await createSyncService({ config, backend, silent: true });

    await backend.push(githubPayload(src.bareUrl, src.sha));
    const processed = await svc.drainAll();
    expect(processed).toBe(1);

    for (const [name, bare] of [["mono", t1], ["backup", t2]] as const) {
      const { dir } = await checkout(tmp, bare, `verify-${name}`);
      expect(await readFileSafe(path.join(dir, "svc1", "app.js"))).toContain("// v1");
    }

    const item = backend.snapshot()[0];
    expect(item.status).toBe("done");
    await svc.stop();
  });

  it("marks event partial when one target fails, and resume retries only the failed target", async () => {
    tmp = await mkTmp();
    const src = await seededBareRepo(tmp, "svc1", { "app.js": "// v1\n" });
    const good = await emptyBareRepo(tmp, "mono");
    const badPath = path.join(tmp, "does-not-exist.git"); // clone will fail

    const backend = new MemoryQueueBackend();
    const config = makeConfig(path.join(tmp, "work"), [
      { provider: "github", repo: good, branch: "main" },
      { provider: "github", repo: badPath, branch: "main" },
    ]);
    const svc = await createSyncService({ config, backend, silent: true });

    const key = await backend.push(githubPayload(src.bareUrl, src.sha));
    await svc.drainAll();

    const item = await backend.get(key);
    expect(item?.status).toBe("partial");
    expect(item?.targets?.[`github:${good}`]).toBe("done");
    expect(item?.targets?.[`github:${badPath}`]).toBe("failed");

    // Now "fix" the bad target by creating the repo, then resume.
    await emptyBareRepo(tmp, "does-not-exist");
    // reset partial -> pending path: worker treats 'partial' as pending and
    // skips already-done targets (idempotency), retrying only the failed one.
    await svc.drainAll();

    const item2 = await backend.get(key);
    expect(item2?.status).toBe("done");
    const { dir } = await checkout(tmp, badPath, "verify-fixed");
    expect(await readFileSafe(path.join(dir, "svc1", "app.js"))).toContain("// v1");
    await svc.stop();
  });
});
