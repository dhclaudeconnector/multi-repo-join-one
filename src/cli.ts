#!/usr/bin/env node
import { loadConfig } from "./config/config.js";
import { createLogger } from "./logger.js";
import { createSyncService } from "./index.js";
import { runSmoke } from "./smoke.js";

const HELP = `multi-repo-join-one (repo-sync)

Usage:
  repo-sync start     Subscribe to the RTDB queue and consume push events (FIFO).
  repo-sync resume    Reset crashed 'processing' items to 'pending' and exit.
  repo-sync status    Print queue backlog with per-item status and exit.
  repo-sync smoke     Run the self-contained smoke test (no network/Firebase).
  repo-sync --help    Show this help.

Configuration is via ENV. See README.md for the full list.
Set FIREBASE_DB_URL=memory://... to run against an in-memory queue.
`;

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "start";

  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }

  if (cmd === "smoke") {
    const log = createLogger({ level: process.env.LOG_LEVEL ?? "info", format: "pretty" });
    const result = await runSmoke(log);
    for (const d of result.details) process.stdout.write(`  - ${d}\n`);
    if (result.ok) {
      process.stdout.write("\n✅ SMOKE PASSED\n");
      process.exit(0);
    } else {
      process.stdout.write("\n❌ SMOKE FAILED\n");
      process.exit(1);
    }
    return;
  }

  const config = loadConfig();
  const logger = createLogger({ level: config.log.level, format: config.log.format });
  const svc = await createSyncService({ config, logger });

  switch (cmd) {
    case "resume": {
      const n = await svc.resume();
      logger.info({ reset: n }, "resume complete");
      await svc.stop();
      break;
    }
    case "status": {
      const items = await svc.backend.listAll();
      for (const i of items) {
        const targets = i.targets ? JSON.stringify(i.targets) : "-";
        process.stdout.write(
          `${i.key}  ${(i.status ?? "pending").padEnd(10)}  ${i.reason ?? ""}  ${targets}\n`
        );
      }
      process.stdout.write(`\n${items.length} item(s)\n`);
      await svc.stop();
      break;
    }
    case "start": {
      const shutdown = async (sig: string) => {
        logger.info({ sig }, "shutting down");
        await svc.stop();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
      await svc.start();
      break;
    }
    default: {
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exit(2);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
