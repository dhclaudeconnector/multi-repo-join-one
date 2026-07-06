import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { simpleGit } from "simple-git";
import type { Logger } from "./logger.js";
import { MemoryQueueBackend } from "./queue/memory.js";
import { createSyncService } from "./index.js";
import type { AppConfig } from "./config/config.js";
import { DEFAULT_COMMIT_TEMPLATE } from "./config/config.js";

/** Sample GitHub push payload (reduced). */
export function githubSample(cloneUrl: string, afterSha: string) {
  return {
    _provider: "github",
    ref: "refs/heads/main",
    before: "0".repeat(40),
    after: afterSha,
    repository: {
      name: "svc1",
      full_name: "orgA/svc1",
      owner: { name: "orgA", login: "orgA" },
      clone_url: cloneUrl,
    },
    pusher: { name: "alice", email: "alice@orgA.com" },
    head_commit: {
      id: afterSha,
      message: "feat: add login",
      author: { name: "Alice", email: "alice@orgA.com" },
    },
  };
}

/** Sample Azure Repos git.push payload (reduced). */
export function azureSample(remoteUrl: string, afterSha: string) {
  return {
    _provider: "azure",
    eventType: "git.push",
    resource: {
      refUpdates: [
        { name: "refs/heads/main", oldObjectId: "0".repeat(40), newObjectId: afterSha },
      ],
      repository: {
        name: "mirror-src",
        project: { name: "contoso" },
        remoteUrl,
      },
      pushedBy: { displayName: "Alice", uniqueName: "alice@contoso.com" },
      commits: [
        {
          commitId: afterSha,
          comment: "feat: azure change",
          author: { name: "Alice", email: "alice@contoso.com" },
        },
      ],
    },
  };
}

/** Initialise a bare git repo and seed it with one commit; returns {bareUrl, sha}. */
export async function makeSeededBareRepo(
  root: string,
  name: string,
  files: Record<string, string>
): Promise<{ bareUrl: string; sha: string }> {
  const bare = path.join(root, `${name}.git`);
  await fs.mkdir(bare, { recursive: true });
  await simpleGit(bare).init(["--bare", "--initial-branch=main"]);

  const work = path.join(root, `${name}-seed`);
  await fs.mkdir(work, { recursive: true });
  const g = simpleGit(work);
  await g.init(["--initial-branch=main"]);
  await g.addConfig("user.name", "seed");
  await g.addConfig("user.email", "seed@localhost");
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(work, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
  await g.add(["-A"]);
  await g.commit("seed");
  await g.addRemote("origin", bare);
  await g.push(["-u", "origin", "main"]);
  const sha = (await g.revparse(["HEAD"])).trim();
  return { bareUrl: bare, sha };
}

/** Create an empty bare target repo with an initial commit on main. */
export async function makeEmptyBareRepo(root: string, name: string): Promise<string> {
  const { bareUrl } = await makeSeededBareRepo(root, name, {
    "README.md": `# ${name}\n`,
  });
  return bareUrl;
}

export interface SmokeResult {
  ok: boolean;
  details: string[];
}

/**
 * Full self-contained smoke test: no real network, no Firebase.
 * - creates local bare source repos (github + azure style) + a bare target
 * - runs the service against an in-memory queue
 * - injects sample GitHub & Azure hooks
 * - asserts code landed under <repo-name>/ in the target with synced metadata
 */
export async function runSmoke(log: Logger): Promise<SmokeResult> {
  const details: string[] = [];
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "repo-sync-smoke-"));
  log.info({ tmp }, "smoke: workspace created");

  try {
    // 1) source repos
    const ghSource = await makeSeededBareRepo(tmp, "svc1", {
      "app.js": "console.log('svc1 hello');\n",
      "nested/util.js": "module.exports = 1;\n",
    });
    const azSource = await makeSeededBareRepo(tmp, "mirror-src", {
      "main.py": "print('azure hello')\n",
    });

    // 2) one target repo (bare)
    const targetBare = await makeEmptyBareRepo(tmp, "mono");

    // 3) config -> memory backend, targets = the local bare target
    const backend = new MemoryQueueBackend();
    const config: AppConfig = {
      firebase: { dbUrl: "memory://smoke", serviceAccount: undefined, queuePath: "/sync-queue" },
      sync: {
        mode: "squash",
        targetConcurrency: 2,
        cloneDepth: 1,
        cloneMaxRetries: 3,
        cloneRetryBackoffMs: 200,
        commitMessageTemplate: DEFAULT_COMMIT_TEMPLATE,
        workDir: path.join(tmp, "work"),
        archiveDone: false,
      },
      // target repo is a local bare path (full url form)
      targets: [{ provider: "github", repo: targetBare, branch: "main" }],
      excludeRepos: [],
      includeRepos: [],
      env: process.env,
      log: { level: "silent", format: "json", includePayload: false },
    };

    const svc = await createSyncService({ config, backend, logger: log });

    // 4) inject sample hooks (GitHub + Azure) with local clone urls
    await backend.push(githubSample(ghSource.bareUrl, ghSource.sha));
    await backend.push(azureSample(azSource.bareUrl, azSource.sha));

    // 5) drain
    const processed = await svc.drainAll();
    details.push(`processed ${processed} events`);

    // 6) verify target content
    const verifyDir = path.join(tmp, "verify");
    await simpleGit().clone(targetBare, verifyDir, ["--branch", "main"]);
    const svc1App = path.join(verifyDir, "svc1", "app.js");
    const svc1Util = path.join(verifyDir, "svc1", "nested", "util.js");
    const azMain = path.join(verifyDir, "mirror-src", "main.py");

    await assertFile(svc1App, "svc1 hello", details);
    await assertFile(svc1Util, "module.exports", details);
    await assertFile(azMain, "azure hello", details);

    // 7) verify commit metadata (Synced-From present)
    const vgit = simpleGit(verifyDir);
    const logText = await vgit.raw(["log", "--pretty=%B", "-n", "5"]);
    if (logText.includes("Synced-From:")) {
      details.push("commit metadata contains Synced-From ✓");
    } else {
      throw new Error("commit metadata missing Synced-From footer");
    }

    // 8) verify queue statuses are done
    const items = backend.snapshot();
    const allDone = items.every((i) => i.status === "done");
    if (!allDone) throw new Error(`not all queue items done: ${items.map((i) => i.status).join(",")}`);
    details.push("all queue items done ✓");

    await svc.stop();
    return { ok: true, details };
  } catch (err) {
    details.push(`ERROR: ${(err as Error).message}`);
    return { ok: false, details };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function assertFile(p: string, needle: string, details: string[]): Promise<void> {
  const content = await fs.readFile(p, "utf8").catch(() => null);
  if (content == null) throw new Error(`expected file missing: ${p}`);
  if (!content.includes(needle)) {
    throw new Error(`file ${p} does not contain "${needle}"`);
  }
  details.push(`verified ${path.basename(path.dirname(p))}/${path.basename(p)} ✓`);
}
