/**
 * Shared domain types for multi-repo-join-one.
 */

export type Provider = "github" | "azure";

/**
 * The canonical push model. Every provider normalizer maps its raw webhook
 * payload down to this shape; everything downstream (validate/clone/push)
 * only works with NormalizedPush.
 */
export interface NormalizedPush {
  provider: Provider;
  /** org / project name, e.g. "orgA" | "contoso" */
  org: string;
  /** bare repo name, used as the destination directory name, e.g. "svc1" */
  repo: string;
  /** "orgA/svc1" */
  fullName: string;
  /** "refs/heads/main" */
  ref: string;
  /** "main" */
  branch: string;
  beforeSha: string;
  /** commit to shallow-clone, e.g. "3f2c..." */
  afterSha: string;
  cloneUrl: string;
  pusher: { name: string; email: string };
  headCommit: {
    message: string;
    author: { name: string; email: string };
  };
  /** idempotency key source (X-GitHub-Delivery etc.) */
  deliveryId: string;
  /** original raw payload, kept for debugging */
  raw: unknown;
}

/**
 * A destination repository declared flatly in TARGETS.
 */
export interface Target {
  provider: Provider;
  /** "orgA/mono" */
  repo: string;
  /** default branch to push to, e.g. "main" */
  branch: string;
}

export type ExcludeRuleType = "startsWith" | "endsWith" | "equal";

export interface ExcludeRule {
  type: ExcludeRuleType;
  value: string;
}

export type QueueItemStatus =
  | "pending"
  | "processing"
  | "done"
  | "skipped"
  | "partial"
  | "failed";

export type TargetStatus = "pending" | "processing" | "done" | "failed";

/**
 * A node stored under RTDB /sync-queue/<pushKey>. The webhook writes only the
 * raw payload; the service augments it with status/targets/timestamps.
 */
export interface QueueItem {
  /** RTDB push key (chronologically ordered) */
  key: string;
  /** raw webhook payload as written by GitHub/Azure */
  payload: unknown;
  status?: QueueItemStatus;
  /** per-target status map, keyed by "provider:repo" */
  targets?: Record<string, TargetStatus>;
  reason?: string;
  createdAt?: number;
  updatedAt?: number;
  /** normalized deliveryId + afterSha, filled during processing */
  deliveryId?: string;
  afterSha?: string;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export type Validator = (push: NormalizedPush) => ValidationResult;
