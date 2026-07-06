import type { AppConfig } from "./config/config.js";
import type { QueueBackend } from "./queue/backend.js";
import { RtdbQueueBackend } from "./queue/rtdb.js";
import { MemoryQueueBackend } from "./queue/memory.js";

/**
 * The listener is intentionally minimal: there is NO HTTP server and NO webhook
 * verification. GitHub/Azure webhooks are configured to POST directly to the
 * RTDB REST endpoint, so this process only *subscribes* to the queue path.
 *
 * This factory picks the backend:
 *   - RTDB in normal operation
 *   - in-memory when FIREBASE_DB_URL is "memory://" (tests/smoke/offline)
 */
export async function createBackend(config: AppConfig): Promise<QueueBackend> {
  if (config.firebase.dbUrl.startsWith("memory://")) {
    return new MemoryQueueBackend();
  }
  return RtdbQueueBackend.create({
    dbUrl: config.firebase.dbUrl,
    queuePath: config.firebase.queuePath,
    serviceAccount: config.firebase.serviceAccount,
    archiveDone: config.sync.archiveDone,
  });
}
