import type { Logger } from "./logger.js";
import type { AppConfig } from "./config/config.js";
import type { QueueBackend } from "./queue/backend.js";
import type { QueueItem, NormalizedPush } from "./types.js";
import { normalize } from "./providers/index.js";
import { buildPipeline, runPipeline } from "./validators/index.js";
import { fanOut, targetKey, type SyncEngineConfig } from "./sync/engine.js";

export interface WorkerDeps {
  config: AppConfig;
  backend: QueueBackend;
  logger: Logger;
}

/**
 * Single-consumer FIFO worker. Guarantees:
 *   - events processed strictly in push-key order (single-flight)
 *   - crashed `processing` items reset to `pending` on resume
 *   - idempotent: an already-`done` target is skipped on re-run
 *   - per-target isolation & partial resume
 */
export class Worker {
  private cfg: AppConfig;
  private backend: QueueBackend;
  private log: Logger;
  private pipeline = buildPipeline();
  private running = false;
  private draining = false;
  private unsub?: () => void;
  private wake?: () => void;
  /** keys seen (already terminal) to avoid reprocessing */
  private terminal = new Set<string>();

  constructor(deps: WorkerDeps) {
    this.cfg = deps.config;
    this.backend = deps.backend;
    this.log = deps.logger;
    this.pipeline = buildPipeline({
      exclude: this.cfg.excludeRepos,
      include: this.cfg.includeRepos,
    });
  }

  private syncEngineConfig(): SyncEngineConfig {
    return {
      workDir: this.cfg.sync.workDir,
      cloneDepth: this.cfg.sync.cloneDepth,
      cloneMaxRetries: this.cfg.sync.cloneMaxRetries,
      cloneRetryBackoffMs: this.cfg.sync.cloneRetryBackoffMs,
      commitMessageTemplate: this.cfg.sync.commitMessageTemplate,
      env: this.cfg.env,
      syncMode: this.cfg.sync.mode,
    };
  }

  /**
   * Reset items that should be retried on (re)start:
   *   - `processing` (crashed mid-flight) -> `pending`
   *   - `partial` (some targets failed)   -> `pending` (idempotency skips done targets)
   * `failed`/`skipped`/`done` are terminal and left as-is.
   */
  async resume(): Promise<number> {
    const items = await this.backend.listAll();
    let reset = 0;
    for (const item of items) {
      if (item.status === "processing" || item.status === "partial") {
        await this.backend.setStatus(item.key, "pending", {
          reason: `reset (${item.status}) on resume`,
        });
        this.terminal.delete(item.key);
        reset++;
      }
      if (item.status === "done" || item.status === "skipped") {
        this.terminal.add(item.key);
      }
    }
    this.log.info(
      { reset, backlog: items.length },
      "resume: reset processing/partial items to pending"
    );
    return reset;
  }

  /** Start realtime subscription + backlog drain loop. Runs until stop(). */
  async start(): Promise<void> {
    this.running = true;
    await this.resume();

    this.unsub = this.backend.onChildAdded(() => {
      this.wake?.();
    });

    this.log.info("worker started; draining backlog");
    await this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const processed = await this.drainOnce();
      if (!this.running) break;
      if (processed === 0) {
        // wait for a wake signal from child_added, or poll after a timeout
        await new Promise<void>((resolve) => {
          this.wake = () => {
            this.wake = undefined;
            resolve();
          };
          setTimeout(() => {
            if (this.wake) {
              this.wake = undefined;
              resolve();
            }
          }, 1000);
        });
      }
    }
  }

  /**
   * Process the smallest non-terminal item once. Returns number processed (0/1).
   * Public so tests can drive it deterministically.
   */
  async drainOnce(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    try {
      const items = await this.backend.listAll();
      const next = items
        .filter((i) => this.isPending(i))
        .sort((a, b) => (a.key < b.key ? -1 : 1))[0];
      if (!next) return 0;
      await this.processItem(next);
      return 1;
    } finally {
      this.draining = false;
    }
  }

  /** Drain the whole backlog synchronously (used by smoke/tests). */
  async drainAll(): Promise<number> {
    let total = 0;
    // guard against infinite loops
    for (let i = 0; i < 100_000; i++) {
      const n = await this.drainOnce();
      if (n === 0) break;
      total += n;
    }
    return total;
  }

  private isPending(item: QueueItem): boolean {
    if (this.terminal.has(item.key)) return false;
    const s = item.status;
    // Only pending/processing are auto-drained. `partial` is retried only via
    // resume() (explicit), so a persistently-failing target never busy-loops.
    return s == null || s === "pending" || s === "processing";
  }

  private async processItem(item: QueueItem): Promise<void> {
    const key = item.key;
    const elog = this.log.child({ key });

    // Normalize
    let push: NormalizedPush;
    try {
      push = normalize(item.payload ?? item);
    } catch (err) {
      elog.warn({ err: (err as Error).message }, "normalize failed; skipping");
      await this.backend.setStatus(key, "skipped", {
        reason: `normalize: ${(err as Error).message}`,
      });
      this.terminal.add(key);
      return;
    }

    const clog = elog.child({
      provider: push.provider,
      sourceRepo: push.fullName,
      ref: push.ref,
      sha: push.afterSha.slice(0, 7),
      deliveryId: push.deliveryId,
      targetCount: this.cfg.targets.length,
    });
    clog.info("event received");

    await this.backend.setStatus(key, "processing", {
      deliveryId: push.deliveryId,
      afterSha: push.afterSha,
    });

    // Validate
    const verdict = runPipeline(this.pipeline, push);
    if (!verdict.ok) {
      clog.info({ reason: verdict.reason }, "validation skip");
      await this.backend.setStatus(key, "skipped", { reason: verdict.reason });
      this.terminal.add(key);
      return;
    }

    if (this.cfg.targets.length === 0) {
      clog.warn("no targets configured; marking done");
      await this.backend.setStatus(key, "done", { reason: "no targets" });
      this.terminal.add(key);
      return;
    }

    // Idempotency / partial resume: skip targets already done.
    const already = item.targets ?? {};
    const pendingTargets = new Set(
      this.cfg.targets
        .map((t) => targetKey(t))
        .filter((tk) => already[tk] !== "done")
    );

    // Fan out (isolated, concurrent, per-target retry inside)
    const result = await fanOut(
      push,
      this.cfg.targets,
      key,
      this.cfg.sync.targetConcurrency,
      this.syncEngineConfig(),
      clog,
      { onlyTargets: pendingTargets }
    );

    // Persist per-target status (merge with previously-done ones)
    const mergedStatus = { ...already, ...result.targetStatus };
    for (const [tk, st] of Object.entries(result.targetStatus)) {
      await this.backend.setTargetStatus(key, tk, st);
    }

    const allDone = this.cfg.targets.every(
      (t) => mergedStatus[targetKey(t)] === "done"
    );
    const anyDone = Object.values(mergedStatus).some((s) => s === "done");

    if (allDone) {
      await this.backend.setStatus(key, "done");
      this.terminal.add(key);
      clog.info({ status: "done" }, "event done");
      if (this.cfg.sync.archiveDone) await this.backend.remove(key);
    } else if (anyDone) {
      const failed = Object.entries(mergedStatus)
        .filter(([, s]) => s !== "done")
        .map(([tk]) => tk);
      await this.backend.setStatus(key, "partial", {
        reason: `failed targets: ${failed.join(", ")}`,
      });
      clog.warn({ status: "partial", failed }, "event partial");
    } else {
      await this.backend.setStatus(key, "failed", {
        reason: "all targets failed",
      });
      clog.error({ status: "failed" }, "event failed");
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.unsub?.();
    this.wake?.();
  }
}
