import type { Logger } from "../logger.js";
import type { NormalizedPush, Target, TargetStatus } from "../types.js";
import { mapWithConcurrency } from "../util/concurrency.js";
import {
  syncToTarget,
  splitRepo,
  type SyncEngineConfig,
  type SyncTargetResult,
} from "./git.js";

export type { SyncEngineConfig, SyncTargetResult } from "./git.js";

export interface FanOutResult {
  overall: "done" | "partial" | "failed";
  results: SyncTargetResult[];
  /** per-target status keyed by targetKey (provider:repo) */
  targetStatus: Record<string, TargetStatus>;
}

/** Stable identity key for a target. */
export function targetKey(t: Target): string {
  return `${t.provider}:${t.repo}`;
}

export interface FanOutOptions {
  /** only sync these target keys (used to resume a partial event) */
  onlyTargets?: Set<string>;
}

/**
 * Fan a single push out to all targets, isolated & concurrent.
 * Each target runs its own clone/copy/commit/push/retry independently.
 * A rejection in one target never affects the others (allSettled semantics).
 */
export async function fanOut(
  push: NormalizedPush,
  targets: Target[],
  queueKey: string,
  concurrency: number,
  cfg: SyncEngineConfig,
  log: Logger,
  opts: FanOutOptions = {}
): Promise<FanOutResult> {
  const selected = opts.onlyTargets
    ? targets.filter((t) => opts.onlyTargets!.has(targetKey(t)))
    : targets;

  if (selected.length === 0) {
    return { overall: "done", results: [], targetStatus: {} };
  }

  const settled = await mapWithConcurrency(
    selected,
    concurrency,
    (target, index) =>
      syncToTarget(push, target, queueKey, index, cfg, log)
  );

  const results: SyncTargetResult[] = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    return {
      target: selected[i],
      ok: false,
      reason: String((s.reason as Error)?.message ?? s.reason),
      reclones: 0,
      pushRetries: 0,
    };
  });

  const targetStatus: Record<string, TargetStatus> = {};
  for (const r of results) {
    targetStatus[targetKey(r.target)] = r.ok ? "done" : "failed";
  }

  const okCount = results.filter((r) => r.ok).length;
  const overall: FanOutResult["overall"] =
    okCount === results.length
      ? "done"
      : okCount === 0
        ? "failed"
        : "partial";

  return { overall, results, targetStatus };
}

export { splitRepo };
