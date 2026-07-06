import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { simpleGit } from "simple-git";
import type { AppConfig } from "../../src/config/config.js";
import { DEFAULT_COMMIT_TEMPLATE } from "../../src/config/config.js";
import type { Target } from "../../src/types.js";

export async function mkTmp(prefix = "repo-sync-it-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function rmTmp(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** Create a bare repo seeded with an initial commit; returns bare path + sha. */
export async function seededBareRepo(
  root: string,
  name: string,
  files: Record<string, string>
): Promise<{ bareUrl: string; sha: string; seedDir: string }> {
  const bare = path.join(root, `${name}.git`);
  await fs.mkdir(bare, { recursive: true });
  const bareGit = simpleGit(bare);
  await bareGit.init(["--bare", "--initial-branch=main"]);
  await bareGit.addConfig("core.autocrlf", "false");

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
  return { bareUrl: bare, sha, seedDir: work };
}

/** Add a new commit to an existing seed dir and push; returns new sha. */
export async function commitAndPush(
  seedDir: string,
  rel: string,
  content: string,
  message: string
): Promise<string> {
  const g = simpleGit(seedDir);
  const p = path.join(seedDir, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
  await g.add(["-A"]);
  await g.commit(message);
  await g.push("origin", "main");
  return (await g.revparse(["HEAD"])).trim();
}

/** Empty bare target repo (with an initial README commit on main). */
export async function emptyBareRepo(root: string, name: string): Promise<string> {
  const { bareUrl } = await seededBareRepo(root, name, { "README.md": `# ${name}\n` });
  return bareUrl;
}

export function makeConfig(
  workDir: string,
  targets: Target[],
  overrides: Partial<AppConfig["sync"]> = {}
): AppConfig {
  return {
    firebase: { dbUrl: "memory://it", serviceAccount: undefined, queuePath: "/sync-queue" },
    sync: {
      mode: "squash",
      targetConcurrency: 3,
      cloneDepth: 1,
      cloneMaxRetries: 3,
      cloneRetryBackoffMs: 50,
      commitMessageTemplate: DEFAULT_COMMIT_TEMPLATE,
      workDir,
      archiveDone: false,
      ...overrides,
    },
    targets,
    excludeRepos: [],
    includeRepos: [],
    env: process.env,
    log: { level: "silent", format: "json", includePayload: false },
  };
}

/** Build a github-style payload pointing at a local bare source repo. */
export function githubPayload(cloneUrl: string, sha: string, repoName = "svc1", message = "change") {
  return {
    _provider: "github",
    ref: "refs/heads/main",
    before: "0".repeat(40),
    after: sha,
    _deliveryId: `gh-${sha}`,
    repository: {
      name: repoName,
      full_name: `orgA/${repoName}`,
      owner: { name: "orgA", login: "orgA" },
      clone_url: cloneUrl,
    },
    pusher: { name: "alice", email: "alice@orgA.com" },
    head_commit: { id: sha, message, author: { name: "Alice", email: "alice@orgA.com" } },
  };
}

/** Clone a bare repo to a temp dir and return SimpleGit + dir. */
export async function checkout(root: string, bareUrl: string, name = "verify") {
  const dir = path.join(root, name);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  const g = simpleGit();
  await g.clone(bareUrl, dir, ["--branch", "main", "--config", "core.autocrlf=false"]);
  const cloned = simpleGit(dir);
  await cloned.addConfig("core.autocrlf", "false");
  return { dir, git: cloned };
}

export async function readFileSafe(p: string): Promise<string | null> {
  return fs.readFile(p, "utf8").catch(() => null);
}
