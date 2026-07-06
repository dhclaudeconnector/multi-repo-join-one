import { promises as fs } from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { Logger } from "../logger.js";
import type { NormalizedPush, Target } from "../types.js";
import { resolveToken, authenticateUrl } from "../config/tokens.js";
import { renderCommitMessage, shortSha } from "./template.js";
import { withRetry } from "../util/retry.js";

export interface SyncEngineConfig {
  workDir: string;
  cloneDepth: number;
  cloneMaxRetries: number;
  cloneRetryBackoffMs: number;
  commitMessageTemplate: string;
  env: NodeJS.ProcessEnv;
  syncMode: "squash" | "replay";
}

export interface SyncTargetResult {
  target: Target;
  ok: boolean;
  reason?: string;
  remoteBefore?: string;
  remoteAfter?: string;
  reclones: number;
  pushRetries: number;
  tokenLevel?: string;
}

/** Recursively copy a directory, skipping the top-level `.git`. */
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else if (entry.isSymbolicLink()) {
      const link = await fs.readlink(s);
      await fs.symlink(link, d).catch(() => fs.copyFile(s, d));
    } else {
      await fs.copyFile(s, d);
    }
  }
}

/** Remove everything (except .git) inside a directory. */
async function clearDirKeepGit(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    await fs.rm(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

async function rmrf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Shallow-clone a source repo at a specific SHA, with fallbacks:
 *   1. init + fetch --depth=N <sha>, checkout FETCH_HEAD  (fast path)
 *   2. clone --depth=N --branch <branch>, then checkout <sha>
 *   3. full clone, then checkout <sha>
 * Wrapped in reclone + backoff retry.
 */
export async function shallowCloneSource(
  push: NormalizedPush,
  destDir: string,
  authUrl: string,
  cfg: SyncEngineConfig,
  log: Logger
): Promise<{ reclones: number }> {
  let reclones = 0;

  await withRetry(
    async (attempt) => {
      if (attempt > 1) reclones++;
      await rmrf(destDir);
      await fs.mkdir(destDir, { recursive: true });

      const git = simpleGit(destDir);

      // Strategy 1: fetch exact SHA (fastest, minimal data).
      try {
        await git.init();
        await git.addConfig("core.autocrlf", "false");
        await git.addRemote("origin", authUrl);
        await git.fetch([
          "--depth",
          String(cfg.cloneDepth),
          "origin",
          push.afterSha,
        ]);
        await git.checkout(["FETCH_HEAD"]);
        log.debug(
          { strategy: "fetch-sha", sha: shortSha(push.afterSha) },
          "source clone ok"
        );
        return;
      } catch (err) {
        log.debug(
          { strategy: "fetch-sha", err: (err as Error).message },
          "fetch-by-sha failed, trying branch clone"
        );
      }

      // Strategy 2: shallow clone the branch, then checkout the SHA.
      await rmrf(destDir);
      await fs.mkdir(destDir, { recursive: true });
      try {
        const g2 = simpleGit();
        await g2.clone(authUrl, destDir, [
          "--depth",
          String(cfg.cloneDepth),
          "--branch",
          push.branch,
          "--single-branch",
        ]);
        const gg = simpleGit(destDir);
        await gg.checkout([push.afterSha]).catch(async () => {
          // SHA not in shallow history -> deepen then checkout
          await gg.fetch(["--unshallow"]).catch(() => undefined);
          await gg.checkout([push.afterSha]);
        });
        log.debug({ strategy: "branch-clone" }, "source clone ok");
        return;
      } catch (err) {
        log.debug(
          { strategy: "branch-clone", err: (err as Error).message },
          "branch clone failed, trying full clone"
        );
      }

      // Strategy 3: full clone + checkout.
      await rmrf(destDir);
      const g3 = simpleGit();
      await g3.clone(authUrl, destDir);
      const gg3 = simpleGit(destDir);
      await gg3.checkout([push.afterSha]);
      log.debug({ strategy: "full-clone" }, "source clone ok");
    },
    {
      retries: cfg.cloneMaxRetries,
      baseMs: cfg.cloneRetryBackoffMs,
      onRetry: (attempt, delayMs, err) =>
        log.warn(
          { attempt, delayMs, err: (err as Error).message },
          "reclone source after failure"
        ),
    }
  );

  return { reclones };
}

/**
 * Sync a single push into a single target. Fully isolated: own work dir, own
 * source clone, own retry. Never throws for expected git failures — returns a
 * SyncTargetResult with ok=false instead.
 */
export async function syncToTarget(
  push: NormalizedPush,
  target: Target,
  queueKey: string,
  targetIndex: number,
  cfg: SyncEngineConfig,
  log: Logger
): Promise<SyncTargetResult> {
  const baseDir = path.join(cfg.workDir, sanitize(queueKey), String(targetIndex));
  const sourceDir = path.join(baseDir, "source");
  const targetDir = path.join(baseDir, "target");
  const result: SyncTargetResult = {
    target,
    ok: false,
    reclones: 0,
    pushRetries: 0,
  };

  const tlog = log.child({
    target: `${target.provider}:${target.repo}`,
    targetIndex,
  });

  try {
    // --- resolve source & target tokens ---
    const srcTok = resolveToken(cfg.env, push.provider, push.org, push.repo);
    const [tOrg, tRepo] = splitRepo(target.repo);
    const tgtTok = resolveToken(cfg.env, target.provider, tOrg, tRepo);
    result.tokenLevel = tgtTok?.level;

    tlog.debug(
      { sourceTokenLevel: srcTok?.level ?? "none", targetTokenLevel: tgtTok?.level ?? "none" },
      "token resolved"
    );

    const sourceAuthUrl = srcTok
      ? authenticateUrl(push.cloneUrl, srcTok.token, push.provider)
      : push.cloneUrl;

    // --- clone source (shallow @ sha, with fallbacks + reclone) ---
    const { reclones } = await shallowCloneSource(
      push,
      sourceDir,
      sourceAuthUrl,
      cfg,
      tlog
    );
    result.reclones = reclones;

    // --- clone target repo (shallow branch) ---
    const targetCloneUrl = targetRemoteUrl(target);
    const targetAuthUrl = tgtTok
      ? authenticateUrl(targetCloneUrl, tgtTok.token, target.provider)
      : targetCloneUrl;

    await rmrf(targetDir);
    await withRetry(
      async () => {
        await rmrf(targetDir);
        const g = simpleGit();
        await g.clone(targetAuthUrl, targetDir, [
          "--depth",
          "1",
          "--branch",
          target.branch,
          "--single-branch",
        ]);
      },
      {
        retries: cfg.cloneMaxRetries,
        baseMs: cfg.cloneRetryBackoffMs,
        onRetry: (attempt, delayMs, err) =>
          tlog.warn(
            { attempt, delayMs, err: (err as Error).message },
            "reclone target after failure"
          ),
      }
    );

    const targetGit = simpleGit(targetDir);
    await configureIdentity(targetGit, push);

    const remoteBefore = (await targetGit.revparse(["HEAD"]).catch(() => "")) || "";
    result.remoteBefore = remoteBefore;

    // --- copy source content into /<repo-name>/ inside the target checkout ---
    const subdir = path.join(targetDir, push.repo);
    await clearDirKeepGit(subdir).catch(() => undefined);
    await fs.mkdir(subdir, { recursive: true });
    await copyDir(sourceDir, subdir);

    // --- stage & commit ---
    await targetGit.add(["-A"]);
    const status = await targetGit.status();
    if (status.staged.length === 0 && status.files.length === 0) {
      tlog.info("no changes to commit; target already up to date");
      result.ok = true;
      result.remoteAfter = remoteBefore;
      return result;
    }

    const message = renderCommitMessage(cfg.commitMessageTemplate, push);
    await targetGit.commit(message, undefined, {
      "--author": `${push.headCommit.author.name} <${push.headCommit.author.email}>`,
    });

    // --- push with rebase-retry on non-fast-forward ---
    const pushRes = await pushWithRebaseRetry(
      targetGit,
      target.branch,
      cfg,
      tlog
    );
    result.pushRetries = pushRes.retries;

    result.remoteAfter = (await targetGit.revparse(["HEAD"]).catch(() => "")) || "";
    result.ok = true;
    tlog.info(
      {
        remoteBefore: shortSha(remoteBefore),
        remoteAfter: shortSha(result.remoteAfter),
        pushRetries: result.pushRetries,
        reclones: result.reclones,
      },
      "target sync done"
    );
    return result;
  } catch (err) {
    result.ok = false;
    result.reason = (err as Error).message;
    tlog.error({ err: (err as Error).message }, "target sync failed");
    return result;
  } finally {
    // cleanup this target's work dir
    await rmrf(baseDir).catch(() => undefined);
  }
}

async function pushWithRebaseRetry(
  git: SimpleGit,
  branch: string,
  cfg: SyncEngineConfig,
  log: Logger
): Promise<{ retries: number }> {
  let retries = 0;
  await withRetry(
    async (attempt) => {
      if (attempt > 1) {
        retries++;
        // pull --rebase the remote target branch before retrying
        await git.pull("origin", branch, { "--rebase": "true" }).catch(() => undefined);
      }
      await git.push("origin", branch);
    },
    {
      retries: cfg.cloneMaxRetries,
      baseMs: cfg.cloneRetryBackoffMs,
      onRetry: (attempt, delayMs, err) =>
        log.warn(
          { attempt, delayMs, err: (err as Error).message },
          "push failed (likely non-fast-forward); rebase + retry"
        ),
    }
  );
  return { retries };
}

async function configureIdentity(
  git: SimpleGit,
  push: NormalizedPush
): Promise<void> {
  const name = push.pusher.name || push.headCommit.author.name || "repo-sync";
  const email =
    push.pusher.email || push.headCommit.author.email || "repo-sync@localhost";
  await git.addConfig("user.name", name);
  await git.addConfig("user.email", email);
}

/** "orgA/mono" -> ["orgA", "mono"]; "mono" -> ["", "mono"]. */
export function splitRepo(repo: string): [string, string] {
  const idx = repo.indexOf("/");
  if (idx === -1) return ["", repo];
  return [repo.slice(0, idx), repo.slice(idx + 1)];
}

/** True if the value is already a usable git remote (URL, scp-like, or local path). */
export function isDirectRemote(repo: string): boolean {
  return (
    /^[a-z]+:\/\//i.test(repo) || // http(s)://, ssh://, git://, file://
    /^[^/\s]+@[^/\s]+:/.test(repo) || // scp-like git@host:org/repo
    repo.startsWith("/") || // absolute local path (bare repo)
    repo.startsWith("./") ||
    repo.startsWith("../") ||
    /^[A-Z]:[/\\]/i.test(repo) // Windows absolute path (e.g. C:\...)
  );
}

/** Build a remote URL for a target from its provider + repo. */
export function targetRemoteUrl(target: Target): string {
  const [org, repo] = splitRepo(target.repo);
  // Already a full URL / ssh / local path -> use as-is.
  if (isDirectRemote(target.repo)) return target.repo;
  if (target.provider === "github") {
    return `https://github.com/${target.repo}.git`;
  }
  // azure
  return org
    ? `https://dev.azure.com/${org}/_git/${repo}`
    : `https://dev.azure.com/_git/${repo}`;
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_");
}
