import { z } from "zod";
import { parseJsonEnv } from "./env.js";
import type { ExcludeRule, Target } from "../types.js";

/* -------------------------------------------------------------------------- */
/* Zod schemas                                                                */
/* -------------------------------------------------------------------------- */

const providerSchema = z.enum(["github", "azure"]);

const targetSchema = z.object({
  provider: providerSchema,
  repo: z.string().min(1),
  branch: z.string().min(1).default("main"),
});

const excludeRuleSchema = z.object({
  type: z.enum(["startsWith", "endsWith", "equal"]),
  value: z.string().min(1),
});

const includeRuleSchema = excludeRuleSchema;

const syncModeSchema = z.enum(["squash", "replay"]).default("squash");

const logLevelSchema = z
  .enum(["trace", "debug", "info", "warn", "error", "silent"])
  .default("info");

const logFormatSchema = z.enum(["json", "pretty"]).default("json");

/* -------------------------------------------------------------------------- */
/* Resolved config shape                                                      */
/* -------------------------------------------------------------------------- */

export interface AppConfig {
  firebase: {
    dbUrl: string;
    /** parsed service account object, or undefined to use ADC/emulator */
    serviceAccount: Record<string, unknown> | undefined;
    queuePath: string;
  };
  sync: {
    mode: "squash" | "replay";
    targetConcurrency: number;
    cloneDepth: number;
    cloneMaxRetries: number;
    cloneRetryBackoffMs: number;
    commitMessageTemplate: string;
    workDir: string;
    /** move finished nodes to /archive instead of deleting */
    archiveDone: boolean;
  };
  targets: Target[];
  excludeRepos: ExcludeRule[];
  includeRepos: ExcludeRule[];
  /** raw process.env, used by the token resolver */
  env: NodeJS.ProcessEnv;
  log: {
    level: z.infer<typeof logLevelSchema>;
    format: z.infer<typeof logFormatSchema>;
    includePayload: boolean;
  };
}

const DEFAULT_COMMIT_TEMPLATE =
  "{message}\n\nSynced-From: {sourceRepo}@{shortSha}\nProvider: {provider}\nPushed-By: {pusherName} <{pusherEmail}>\nOriginal-Author: {authorName} <{authorEmail}>\nRef: {ref}";

function boolEnv(v: string | undefined, def = false): boolean {
  if (v == null) return def;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

function intEnv(v: string | undefined, def: number): number {
  if (v == null || v.trim() === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * Load and validate configuration from an env object (defaults to process.env).
 * Fails fast with a clear error if anything is malformed.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dbUrl = env.FIREBASE_DB_URL?.trim() ?? "";
  if (!dbUrl) {
    throw new Error("FIREBASE_DB_URL is required");
  }

  // Service account can be inline JSON, base64 JSON, or a file path.
  let serviceAccount: Record<string, unknown> | undefined;
  const saRaw = env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (saRaw) {
    if (saRaw.startsWith("{") || /^[A-Za-z0-9+/]+={0,2}$/.test(saRaw)) {
      serviceAccount = parseJsonEnv<Record<string, unknown>>(
        "FIREBASE_SERVICE_ACCOUNT",
        saRaw
      );
    } else {
      // treat as file path; loaded lazily by the RTDB client
      serviceAccount = { __path: saRaw };
    }
  }

  const targets = z
    .array(targetSchema)
    .parse(parseJsonEnv<unknown[]>("TARGETS", env.TARGETS, []));

  const excludeRepos = z
    .array(excludeRuleSchema)
    .parse(parseJsonEnv<unknown[]>("EXCLUDE_REPOS", env.EXCLUDE_REPOS, []));

  const includeRepos = z
    .array(includeRuleSchema)
    .parse(parseJsonEnv<unknown[]>("INCLUDE_REPOS", env.INCLUDE_REPOS, []));

  const config: AppConfig = {
    firebase: {
      dbUrl,
      serviceAccount,
      queuePath: env.RTDB_QUEUE_PATH?.trim() || "/sync-queue",
    },
    sync: {
      mode: syncModeSchema.parse(env.SYNC_MODE),
      targetConcurrency: intEnv(env.TARGET_CONCURRENCY, 3),
      cloneDepth: intEnv(env.CLONE_DEPTH, 1),
      cloneMaxRetries: intEnv(env.CLONE_MAX_RETRIES, 3),
      cloneRetryBackoffMs: intEnv(env.CLONE_RETRY_BACKOFF_MS, 2000),
      commitMessageTemplate:
        env.COMMIT_MESSAGE_TEMPLATE?.replace(/\\n/g, "\n") ||
        DEFAULT_COMMIT_TEMPLATE,
      workDir: env.WORK_DIR?.trim() || "/tmp/repo-sync",
      archiveDone: boolEnv(env.ARCHIVE_DONE, false),
    },
    targets,
    excludeRepos,
    includeRepos,
    env,
    log: {
      level: logLevelSchema.parse(env.LOG_LEVEL),
      format: logFormatSchema.parse(env.LOG_FORMAT),
      includePayload: boolEnv(env.LOG_INCLUDE_PAYLOAD, false),
    },
  };

  return config;
}

export {
  targetSchema,
  excludeRuleSchema,
  providerSchema,
  DEFAULT_COMMIT_TEMPLATE,
};
