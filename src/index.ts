import { loadConfig, type AppConfig } from "./config/config.js";
import { createLogger, createSilentLogger, type Logger } from "./logger.js";
import { createBackend } from "./listener.js";
import { Worker } from "./worker.js";
import type { QueueBackend } from "./queue/backend.js";

export interface SyncServiceOptions {
  /** override env source (defaults to process.env) */
  env?: NodeJS.ProcessEnv;
  /** inject a pre-built config (skips loadConfig) */
  config?: AppConfig;
  /** inject a backend (e.g. shared MemoryQueueBackend for tests) */
  backend?: QueueBackend;
  /** inject a logger */
  logger?: Logger;
  /** disable logging */
  silent?: boolean;
}

export interface SyncService {
  config: AppConfig;
  backend: QueueBackend;
  worker: Worker;
  logger: Logger;
  /** start realtime listening + FIFO consumer (runs until stop) */
  start(): Promise<void>;
  /** reset crashed items, returns count reset */
  resume(): Promise<number>;
  /** drain the current backlog once and return (does not keep listening) */
  drainAll(): Promise<number>;
  stop(): Promise<void>;
}

/**
 * Build a sync service. No HTTP server is created and no webhook verification
 * is performed — the service only subscribes to the RTDB queue path.
 */
export async function createSyncService(
  opts: SyncServiceOptions = {}
): Promise<SyncService> {
  const config = opts.config ?? loadConfig(opts.env);
  const logger =
    opts.logger ??
    (opts.silent
      ? createSilentLogger()
      : createLogger({ level: config.log.level, format: config.log.format }));

  const backend = opts.backend ?? (await createBackend(config));
  const worker = new Worker({ config, backend, logger });

  return {
    config,
    backend,
    worker,
    logger,
    async start() {
      await worker.start();
    },
    async resume() {
      return worker.resume();
    },
    async drainAll() {
      await worker.resume();
      return worker.drainAll();
    },
    async stop() {
      await worker.stop();
      await backend.close();
    },
  };
}

/* Public re-exports for programmatic use. */
export { loadConfig } from "./config/config.js";
export type { AppConfig } from "./config/config.js";
export { parseJsonEnv, encodeJsonEnv, EnvParseError } from "./config/env.js";
export { resolveToken, authenticateUrl } from "./config/tokens.js";
export { normalize, normalizeGithub, normalizeAzure, detectProvider } from "./providers/index.js";
export { buildPipeline, runPipeline, validateHookShape, makeRepoNameValidator } from "./validators/index.js";
export { renderCommitMessage } from "./sync/template.js";
export { fanOut, targetKey } from "./sync/engine.js";
export { MemoryQueueBackend } from "./queue/memory.js";
export { RtdbQueueBackend } from "./queue/rtdb.js";
export { generatePushId } from "./queue/pushId.js";
export { Worker } from "./worker.js";
export * from "./types.js";
