# multi-repo-join-one

> **GitHub / Azure Repos → one-or-many target repos sync service.**
> A Node.js service (publishable to npm) that **listens to Firebase Realtime Database (RTDB)** — **no HTTP server, no webhook verification**. GitHub/Azure webhooks POST **directly** into an RTDB path; this service subscribes to that path and processes each push **FIFO**, shallow-cloning the exact commit and fanning it out into every configured target repo, preserving the original commit message + push metadata.

Durable across restarts, idempotent, with per-target isolation, token fallback, and detailed structured logging.

---

## How it works

```
[Repo A] --webhook (URL = RTDB REST endpoint)--\
[Repo B] --webhook------------------------------> [RTDB /sync-queue/<pushKey>]
[Repo C] --webhook-----------------------------/            |
                                                            | child_added / backlog scan
                                                            v
                                     [Node service: NO HTTP, NO verify]
                                                     |
                                       [single-consumer FIFO by push key]
                                                     |
                                       [sync engine] --> [target 1]
                                                    \--> [target 2]
                                                     \-> [target 3]
                                       keeps original commit msg + metadata
```

- **RTDB is the direct receiver + source of truth.** Point each repo's webhook Payload URL at
  `https://<db>.firebaseio.com/sync-queue.json?auth=<token>`. Firebase assigns a chronologically-ordered **push key** per event.
- **No HTTP server, no HMAC verify.** Security is enforced via **RTDB security rules** (write-only to the queue path) + the auth token in the URL.
- **FIFO:** a single event-level consumer processes push keys in ascending (= chronological) order.
- **Fan-out:** each target repo is an **isolated pipeline** (own work dir, own source clone, own retry). One target failing never affects the others.
- **Shallow clone by SHA** (`--depth=1`) with fallbacks (fetch-by-sha → branch clone → full clone) and reclone/backoff retry.
- **Durable:** on restart, `processing`/`partial` items are reset and retried; idempotency (deliveryId + SHA + target) means re-runs never create duplicate commits.

Destination directory = **source repo name** (auto-derived). A push from `orgA/svc1` lands under `svc1/…` inside each target.

---

## Install

```bash
npm install multi-repo-join-one
# or run the CLI without installing
npx repo-sync --help
```

Requires Node ≥ 18 and `git` available on PATH.

---

## CLI

```bash
repo-sync start     # subscribe to the RTDB queue and consume events (FIFO), runs forever
repo-sync resume    # reset crashed 'processing'/'partial' items to 'pending' and exit
repo-sync status    # print the queue backlog with per-item status and exit
repo-sync smoke     # run the self-contained smoke test (no network / no Firebase)
repo-sync --help
```

`repo-sync smoke` spins the full service against an in-memory queue + local bare git repos, injects a sample GitHub and Azure push, and asserts the code landed in the target under `<repo-name>/` with `Synced-From` metadata. It needs no real repos or Firebase — ideal for CI.

---

## Programmatic API

```ts
import { createSyncService } from "multi-repo-join-one";

const svc = await createSyncService();     // reads config from process.env
await svc.resume();                        // recover crashed items
await svc.start();                         // listen + consume (runs until stop)

// or process the current backlog once and return:
const n = await svc.drainAll();
await svc.stop();
```

Other exports: `loadConfig`, `parseJsonEnv`, `encodeJsonEnv`, `resolveToken`, `normalize`,
`buildPipeline`, `renderCommitMessage`, `fanOut`, `MemoryQueueBackend`, `RtdbQueueBackend`,
`generatePushId`, `Worker`.

---

## Configuration (ENV)

All dynamic behaviour is ENV-driven — nothing is hardcoded.

### Firebase / queue

```env
FIREBASE_DB_URL=https://<db>.firebaseio.com     # required
FIREBASE_SERVICE_ACCOUNT=                        # inline JSON, base64 JSON, or a file path
RTDB_QUEUE_PATH=/sync-queue
ARCHIVE_DONE=false                               # move finished nodes to <path>-archive instead of deleting
```

> Set `FIREBASE_DB_URL=memory://...` to run against an in-memory queue (tests / offline / smoke).

### Targets (flat list, applied to every valid source)

```env
TARGETS=[
  {"provider":"github","repo":"orgA/mono","branch":"main"},
  {"provider":"github","repo":"orgA/backup-mono","branch":"main"},
  {"provider":"azure","repo":"contoso/mirror","branch":"main"}
]
```

`repo` may also be a full URL, an `ssh` remote, or a local path (used in tests).

### Source filtering (multi-level rules)

A repo matching **any** exclude rule is skipped (no clone/push). If `INCLUDE_REPOS` is non-empty, a repo must also match at least one include rule.

```env
EXCLUDE_REPOS=[
  {"type":"startsWith","value":"test-"},
  {"type":"endsWith","value":"-sandbox"},
  {"type":"equal","value":"orgA/playground"}
]
INCLUDE_REPOS=[]
```

Rules match against both the bare repo name and `org/repo`. Add new match kinds (regex, glob…) by extending `src/validators/repoName.ts`.

### Token fallback (`repo → org → global → default`)

```env
TOKEN__DEFAULT=
TOKEN__GITHUB=ghp_xxx
TOKEN__AZURE=azdo_xxx
TOKEN__GITHUB__ORGA=ghp_orgA
TOKEN__GITHUB__ORGA__SVC1=ghp_svc1_specific
TOKEN__AZURE__CONTOSO__PAYMENTS=azdo_payments_specific
```

Resolution order for `provider/org/repo`:
`TOKEN__<PROVIDER>__<ORG>__<REPO>` → `TOKEN__<PROVIDER>__<ORG>` → `TOKEN__<PROVIDER>` → `TOKEN__DEFAULT`.
Segments are uppercased and non-alphanumerics become `_` (`svc-1` → `SVC_1`). The resolved **level** is logged; the value never is.

### Sync behaviour

```env
SYNC_MODE=squash                 # squash | replay
TARGET_CONCURRENCY=3             # parallel targets (bounded to avoid rate limits)
CLONE_DEPTH=1                    # shallow depth
CLONE_MAX_RETRIES=3
CLONE_RETRY_BACKOFF_MS=2000      # exponential: 2s, 4s, 8s...
COMMIT_MESSAGE_TEMPLATE="{message}\n\nSynced-From: {sourceRepo}@{shortSha}\nProvider: {provider}\nPushed-By: {pusherName} <{pusherEmail}>"
WORK_DIR=/tmp/repo-sync
```

Commit template placeholders: `{message} {sourceRepo} {sha} {shortSha} {provider} {pusherName} {pusherEmail} {authorName} {authorEmail} {ref} {branch} {org} {repo} {fullName}`.

### Logging

```env
LOG_LEVEL=info                   # trace|debug|info|warn|error|silent
LOG_FORMAT=json                  # json (prod) | pretty (dev)
LOG_INCLUDE_PAYLOAD=false
```

### Safe JSON parsing (base64 → raw fallback)

Every JSON-shaped ENV (`TARGETS`, `EXCLUDE_REPOS`, `INCLUDE_REPOS`, `FIREBASE_SERVICE_ACCOUNT`) is parsed by `parseJsonEnv`, which:

1. tries **base64 decode → JSON.parse** (survives shell/CI mangling),
2. falls back to **raw JSON.parse**,
3. otherwise throws a clear error naming the variable.

For prod/CI, encode with the helper:

```js
const { encodeJsonEnv } = require("multi-repo-join-one");
console.log(encodeJsonEnv([{ provider: "github", repo: "orgA/mono", branch: "main" }]));
```

---

## RTDB security rules (recommended)

Because there is no webhook verification, lock the queue path down: write-only, no read/update/delete from the public, and require the auth token in the URL. Example:

```json
{
  "rules": {
    "sync-queue": {
      ".read": false,
      "$pushId": { ".write": "!data.exists()" }
    }
  }
}
```

The service itself connects with a service account and has full access.

---

## Development

```bash
npm install
npm run build        # tsup -> dist/ (CJS + d.ts)
npm run typecheck    # tsc --noEmit
npm test             # vitest: unit + integration + smoke
npm run smoke        # node dist/cli.js smoke
```

### Project layout

```
src/
├─ index.ts            # createSyncService(config) programmatic API
├─ cli.ts              # repo-sync start | resume | status | smoke
├─ listener.ts         # backend factory (RTDB or memory) — NO http, NO verify
├─ worker.ts           # single-consumer FIFO by push key + resume + idempotency
├─ queue/
│  ├─ backend.ts       # QueueBackend interface
│  ├─ rtdb.ts          # Firebase RTDB backend
│  ├─ memory.ts        # in-memory backend (tests/offline)
│  └─ pushId.ts        # Firebase-style ordered push id generator
├─ validators/         # index (pipeline) + hookShape + repoName (startsWith/endsWith/equal)
├─ providers/          # github.ts, azure.ts normalizers + detect + index
├─ sync/
│  ├─ git.ts           # shallow clone by SHA + fallback/retry, copy, commit, push per target
│  ├─ engine.ts        # fan-out with bounded concurrency (Promise.allSettled)
│  └─ template.ts      # commit message renderer
├─ config/
│  ├─ env.ts           # parseJsonEnv (base64 -> raw) + encodeJsonEnv
│  ├─ config.ts        # zod-validated AppConfig (fail-fast)
│  └─ tokens.ts        # resolver repo->org->global->default
├─ logger.ts           # pino structured logging
└─ smoke.ts            # self-contained smoke harness
test/
├─ fixtures/           # github-push.json, azure-push.json, invalid variant
├─ unit/               # env-parse, tokens, validators, normalizer, template, config, pushid
├─ integration/        # queue-resume/FIFO, multi-target/partial, idempotency, clone-retry
└─ smoke/              # spins service + local bare repos, both providers
```

---

## Out of scope (v1)

Complex automatic merge-conflict resolution, two-way sync, syncing issues/PRs/wiki. Only code content is synced.

## License

MIT

### RTDB emulator smoke test

The normal smoke test is fully self-contained and uses the in-memory queue. To verify the real Firebase RTDB backend, install/cache the RTDB emulator once, then run the dedicated smoke test:

```bash
npm run setup:rtdb-emulator
npm run test:smoke:rtdb
```

This test starts the Firebase Database emulator, POSTs GitHub/Azure webhook-shaped payloads directly to `/sync-queue.json`, drains them through `RtdbQueueBackend`, and verifies the target repo receives `/<source-repo-name>/...`. In offline CI where the emulator jar is not cached, the test exits with a clear skip warning instead of failing for a network download.

## Deployment files added

This package includes production deployment helpers:

- `DEPLOY.md` - end-to-end deploy guide for GitHub org webhook -> Firebase RTDB -> GitHub Actions/Azure Pipelines.
- `.env.example` - fully commented ENV reference with allowed values and examples.
- `.deploy/env.prod` - production template for GitHub org sources, personal GitHub target repo, and Azure target repo.
- `.github/workflows/repo-sync-hourly.yml` - GitHub Actions job scheduled every 60 minutes with log artifacts.
- `azure-pipelines.yml` - Azure Pipelines equivalent with log artifact publishing.
- `scripts/check-output.js` - verifies source/target state from `env.prod` and job artifacts.
- `scripts/bootstrap-from-env.sh` - creates/updates GitHub org webhook and sets GitHub Actions secrets from `env.prod`.

Quick commands:

```bash
npm run bootstrap:api
npm run check:output
```
