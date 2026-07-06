import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
import { createSilentLogger } from "../../src/logger.js";
import { createSyncService } from "../../src/index.js";
import { DEFAULT_COMMIT_TEMPLATE, type AppConfig } from "../../src/config/config.js";
import { RtdbQueueBackend } from "../../src/queue/rtdb.js";
import { githubSample, azureSample, makeEmptyBareRepo, makeSeededBareRepo } from "../../src/smoke.js";

const EMULATOR_TIMEOUT_MS = 60_000;

async function hasCachedDatabaseEmulator(): Promise<boolean> {
  const cacheDir = path.join(os.homedir(), ".cache", "firebase", "emulators");
  const entries = await fs.readdir(cacheDir).catch(() => []);
  return entries.some((name) => /^firebase-database-emulator-.*\.jar$/.test(name));
}

let activeEmulator: ChildProcessWithoutNullStreams | undefined;
let previousEmulatorHost: string | undefined;

afterEach(async () => {
  if (activeEmulator) {
    const child = activeEmulator;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) =>
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
          resolve(undefined);
        }, 5000)
      ),
    ]);
    activeEmulator = undefined;
  }
  if (previousEmulatorHost === undefined) {
    delete process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  } else {
    process.env.FIREBASE_DATABASE_EMULATOR_HOST = previousEmulatorHost;
  }
});

describe("smoke (Firebase RTDB emulator)", () => {
  it(
    "accepts webhook-shaped REST POSTs into RTDB and drains them through the real RTDB backend",
    async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "repo-sync-rtdb-smoke-"));
      const projectId = "repo-sync-smoke";
      const port = 19_000 + Math.floor(Math.random() * 1000);

      if (!(await hasCachedDatabaseEmulator())) {
        console.warn(
          "Skipping RTDB emulator smoke: firebase-database-emulator jar is not cached. " +
            "Run `npx firebase setup:emulators:database` once in an online environment, then rerun this test."
        );
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
        return;
      }

      try {
        await writeFirebaseConfig(tmp, port);
        activeEmulator = await startDatabaseEmulator(tmp, projectId, port);
        previousEmulatorHost = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
        process.env.FIREBASE_DATABASE_EMULATOR_HOST = `127.0.0.1:${port}`;

        const ghSource = await makeSeededBareRepo(tmp, "svc1", {
          "app.js": "console.log('svc1 via rtdb emulator');\n",
        });
        const azSource = await makeSeededBareRepo(tmp, "mirror-src", {
          "main.py": "print('azure via rtdb emulator')\n",
        });
        const targetBare = await makeEmptyBareRepo(tmp, "mono");

        const backend = await RtdbQueueBackend.create({
          dbUrl: `https://${projectId}.firebaseio.com`,
          queuePath: "/sync-queue",
          appName: `repo-sync-rtdb-smoke-${Date.now()}`,
        });

        const config: AppConfig = {
          firebase: {
            dbUrl: `https://${projectId}.firebaseio.com`,
            serviceAccount: undefined,
            queuePath: "/sync-queue",
          },
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
          targets: [{ provider: "github", repo: targetBare, branch: "main" }],
          excludeRepos: [],
          includeRepos: [],
          env: process.env,
          log: { level: "silent", format: "json", includePayload: false },
        };

        const service = await createSyncService({
          config,
          backend,
          logger: createSilentLogger(),
        });

        // Simulate GitHub/Azure webhook POSTing directly to RTDB REST path.
        await postWebhookToRtdb(port, projectId, "/sync-queue", githubSample(ghSource.bareUrl, ghSource.sha));
        await postWebhookToRtdb(port, projectId, "/sync-queue", azureSample(azSource.bareUrl, azSource.sha));

        const processed = await service.drainAll();
        expect(processed).toBe(2);

        const verifyDir = path.join(tmp, "verify");
        await simpleGit().clone(targetBare, verifyDir, ["--branch", "main"]);
        await expect(fs.readFile(path.join(verifyDir, "svc1", "app.js"), "utf8")).resolves.toContain(
          "svc1 via rtdb emulator"
        );
        await expect(fs.readFile(path.join(verifyDir, "mirror-src", "main.py"), "utf8")).resolves.toContain(
          "azure via rtdb emulator"
        );

        const items = await backend.listAll();
        expect(items).toHaveLength(2);
        expect(items.map((i) => i.status)).toEqual(["done", "done"]);

        await service.stop();
      } finally {
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    120_000
  );
});

async function writeFirebaseConfig(root: string, port: number): Promise<void> {
  await fs.writeFile(
    path.join(root, "firebase.json"),
    JSON.stringify(
      {
        database: { rules: "database.rules.json" },
        emulators: { database: { host: "127.0.0.1", port } },
      },
      null,
      2
    )
  );
  await fs.writeFile(
    path.join(root, "database.rules.json"),
    JSON.stringify({ rules: { ".read": true, ".write": true } }, null, 2)
  );
}

async function startDatabaseEmulator(
  cwd: string,
  projectId: string,
  port: number
): Promise<ChildProcessWithoutNullStreams> {
  const bin = path.resolve("node_modules/.bin/firebase");
  const child = spawn(
    bin,
    ["emulators:start", "--only", "database", "--project", projectId, "--config", "firebase.json"],
    { cwd, stdio: "pipe", env: { ...process.env, FIREBASE_CLI_PREVIEWS: "emulator_logging" } }
  );

  activeEmulator = child;
  let output = "";
  const started = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`RTDB emulator did not start on port ${port}. Output:\n${output}`));
    }, EMULATOR_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (/All emulators ready/.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`RTDB emulator exited early with code ${code}. Output:\n${output}`));
    });
  });

  await started;
  await waitForPort(port);
  return child;
}

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await httpRequest({ hostname: "127.0.0.1", port, path: "/.json?ns=repo-sync-smoke", method: "GET" });
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("RTDB emulator port did not become ready");
}

async function postWebhookToRtdb(
  port: number,
  projectId: string,
  queuePath: string,
  payload: unknown
): Promise<void> {
  const body = JSON.stringify(payload);
  await httpRequest({
    hostname: "127.0.0.1",
    port,
    path: `${queuePath}.json?ns=${projectId}`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
    body,
  });
}

function httpRequest(options: http.RequestOptions & { body?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}
