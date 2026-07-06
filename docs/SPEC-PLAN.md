# Spec & Plan: GitHub Multi-Repo Sync Service (Node.js + Firebase RTDB)

# GitHub Multi-Repo Sync Service
> Dịch vụ Node.js (publish được lên npm) **lắng nghe thay đổi của Google Realtime Database (RTDB)**, KHÔNG chạy HTTP server, KHÔNG verify gì cả. Webhook GitHub được cấu hình bắn **thẳng** vào 1 path trong RTDB; Node lắng nghe path đó và xử lý luôn theo queue FIFO. Có push data trong RTDB → validate rule (bỏ qua repo theo startsWith/endsWith/equal) → **shallow clone đúng commit đó** (`--depth`) cho nhanh → đưa vào thư mục = tên repo → push lên (các) repo đích. Bền vững, resume sau restart, có reclone + retry khi lỗi. Config động ở ENV, đa provider + token fallback theo repo/org/global.
* * *
## 1\. Mục tiêu & phạm vi
**Bài toán:** Gom nhiều repo (GitHub, Azure Repos...) riêng lẻ về 1 hoặc nhiều repo đích. Mỗi khi 1 repo con có push, code được đẩy vào (các) repo đích, mang theo commit message gốc + thông tin người push.

**Yêu cầu cốt lõi:**
1. Node **không có HTTP server**, chỉ `subscribe` thay đổi trên RTDB.
2. Webhook GitHub cấu hình bắn **thẳng** vào 1 path trong RTDB. **Không có lớp verify / Cloud Function / HTTP nào cả.**
3. Node lắng nghe path đó, xử lý luôn **theo queue FIFO**: push trước đẩy lên trước.
4. Sync code vào (các) repo đích, giữ commit message gốc + bổ sung metadata (push user, repo nguồn, sha gốc...).
5. **Thư mục đích = tên repo nguồn**, tự suy ra, không cần khai báo mapping source → dir.
6. **1 repo nguồn → nhiều repo đích:** 1 push có thể join vào 2-3 repo đích cùng lúc.
7. **Filter repo nguồn nhiều cấp** (`startsWith`/`endsWith`/`equal`) qua validator pipeline dễ đổi; **shallow clone theo commit** + reclone/retry.
8. **Xử lý hook data cả GitHub lẫn Azure Repos** (normalizer về 1 model chung), kèm payload mẫu.
9. **ENV JSON an toàn:** parse có fallback **base64 → raw** để config không vỡ qua shell/CI.
10. **Bền vững:** Node tắt/mở lại → event chưa xử lý được đẩy tiếp (không mất, không trùng).
11. **Đa provider + token fallback:** PAT riêng theo repo, hoặc chung, fallback `repo → org → global`.
12. **Log chi tiết** toàn bộ vòng đời event.
13. **Test đầy đủ là điều kiện hoàn thành:** unit từng trường hợp + smoke test tự chạy service + xử lý hook data mẫu (GitHub & Azure).
14. Đóng gói dạng **npm package** (CLI + programmatic API).

**Ngoài phạm vi (v1):** merge conflict tự động phức tạp, sync 2 chiều, sync issue/PR/wiki. Chỉ sync nội dung code.

* * *
## 2\. Kiến trúc tổng quan

```plain
[Repo con A] --GitHub webhook (URL = RTDB REST của path)-->\
[Repo con B] --GitHub webhook-------------------------------> [RTDB /sync-queue/<autoId>]
[Repo con C] --GitHub webhook-------------------------------/            |
                                                                         | (child_added / quét backlog)
                                                                         v
                                                    [Node Service: KHÔNG HTTP, KHÔNG verify]
                                                                  |
                                                        [Consumer FIFO theo thứ tự push]
                                                                  |
                                                        [Sync engine] --> [Repo đích 1]
                                                                     \--> [Repo đích 2]
                                                                      \-> [Repo đích 3]
                                                        giữ commit msg + metadata
```

**Thành phần:**
*   **RTDB (điểm nhận trực tiếp + nguồn sự thật):** GitHub webhook URL trỏ **thẳng** vào REST endpoint của RTDB path (ví dụ `https://<db>.firebaseio.com/sync-queue.json?auth=<token>`). Mỗi push → 1 node mới dưới `/sync-queue`. Không có server trung gian. Node dùng `push key` của RTDB (đã tăng dần theo thời gian) làm thứ tự.
*   **Node Service (npm package):** subscribe `/sync-queue` (`child_added` + quét lúc khởi động), **không mở port, không verify**. Là **single-consumer** xử lý tuần tự theo thứ tự key.
*   **Validator pipeline:** trước khi xử lý, chạy chuỗi kiểm tra tách rời, dễ chỉnh: verify tên repo (rule startsWith/endsWith/equal → skip), verify cấu trúc hook data (có `after` SHA, `repository.name`, `ref`...). Chỉ khi pass hết mới clone + push.
*   **Sync engine:** **shallow clone** đúng commit (`--depth=1`) cho nhanh; **mỗi đích có work dir + clone nguồn riêng, copy ra thư mục riêng** (không gom chung), chạy song song cô lập, commit + push + retry độc lập từng đích. Có reclone + retry khi lỗi.
*   **Config layer:** ENV cho token resolver (fallback) + danh sách repo đích + rule filter; state động ở RTDB.
*   **Logger:** structured logging (pino) xuyên suốt, gắn key/`deliveryId` để trace 1 event từ nhận → validate → clone → commit → push (mỗi đích) → done.

* * *
## 2b. Webhook GitHub bắn thẳng vào RTDB (không HTTP, không verify)
*   **Cấu hình webhook:** ở mỗi repo con, đặt Payload URL = REST endpoint của RTDB path kèm auth token, ví dụ `https://<db>.firebaseio.com/sync-queue.json?auth=<db-secret-or-token>`, Content-Type `application/json`. GitHub POST payload → Firebase tự tạo 1 node con dưới `/sync-queue` (nếu dùng `POST`, Firebase sinh **push key** đã sắp theo thời gian).
*   **Không verify:** theo yêu cầu, bỏ hoàn toàn HMAC/secret check. Bù lại phải khoá bằng **RTDB security rules** (chỉ cho ghi vào đúng path, không cho đọc/sửa) + auth token trong URL để hạn chế spam.
*   **Thứ tự push:** dựa vào **push key** của Firebase (`-Nxxxx`, mã hoá timestamp + counter, tăng dần từ điển). Node xử lý theo thứ tự key tăng dần = thứ tự đến. Với cùng 1 repo, thứ tự đến gần như luôn khớp thứ tự push.
*   **Node service** chỉ là **RTDB listener**: chạy được ở môi trường không expose port (máy nội bộ, container private), RTDB đóng vai trò buffer + queue bền vững.

* * *
## 3\. Chiến lược đồng bộ (sync)
Đề xuất **subtree-per-repo**: mỗi repo nguồn map vào 1 thư mục con **trùng tên repo** (`/<repo-name>/...`) trong mỗi repo đích. Tên thư mục **tự suy ra** từ `repository.name` trong payload, không cần khai báo mapping. Tránh đụng lịch sử, dễ audit nguồn.

**Validator pipeline (dễ thay đổi):** trước khi làm gì, chạy chuỗi validator tách rời, mỗi cái 1 hàm nhỏ, thêm/bớt/đổi dễ dàng:

1. `validateHookShape` — hook data đủ field (`repository.name`, `after` SHA, `ref`, `pusher`...). Thiếu → skip + log.
2. `validateRepoName` — so tên repo với danh sách rule (`startsWith` / `endsWith` / `equal`). Khớp bất kỳ rule loại trừ → **skip**, không đưa vào nguồn.
3. (mở rộng sau) validate branch, validate size... cùng interface `(event) => {ok, reason}`.

Luồng xử lý 1 push event:

1. Listener nhận node mới từ `/sync-queue` (hoặc lấy key nhỏ nhất chưa xử lý khi khởi động).
2. Mark `processing`. Chạy **validator pipeline**. Fail → mark `skipped` + log lý do, không clone.
3. Đọc `repository.name` → tên thư mục đích. Tra danh sách đích. **Fan-out: mỗi đích chạy 1 luồng độc lập** (mục 3c), không phụ thuộc nhau.
4. **Trong từng luồng đích:** clone nguồn về **work dir riêng của đích đó** (shallow theo `after` SHA), copy nội dung (bỏ `.git`) vào thư mục `/<repo-name>/` trong checkout đích, commit với message template, push. Resolve token đích riêng theo fallback. Retry nằm **bên trong** luồng.
5. Commit message:

```plain
<original commit message>

Synced-From: <source repo>@<short-sha>
Provider: <github|azure>
Pushed-By: <pusher.name> <<pusher.email>>
Original-Author: <author.name> <<author.email>>
Ref: <ref>
```

1. Non-fast-forward ở 1 đích → `pull --rebase` + retry **chỉ trong luồng đích đó**; lỗi cứng → mark đích đó `failed` + log + alert, các đích khác **không bị ảnh hưởng**.
2. Khi **tất cả** luồng đích kết thúc → tổng hợp: tất cả ok → `done`; 1 phần fail → `partial` kèm danh sách đích lỗi để resume retry riêng.

**Shallow clone + reclone + retry:** clone chỉ `--depth=1` tại đúng SHA. Nếu clone/fetch lỗi (mạng, SHA chưa propagate, partial clone hỏng) → **xoá work dir, reclone lại** với backoff (ví dụ 3 lần, 2s/4s/8s). Nếu shallow fetch SHA cụ thể fail (server không cho fetch theo sha) → fallback clone `--depth` lớn hơn hoặc theo branch rồi checkout. Mọi bước clone/push đều bọc retry.

**Giữ thứ tự khi nhiều commit trong 1 push:** `SYNC_MODE=squash` (1 commit/push, đủ v1 và hợp với shallow) hoặc `replay` (cần depth lớn hơn để có từng commit) — chọn qua ENV.

* * *
## 3c. Xử lý song song, cô lập từng đích
Mỗi repo đích là **1 pipeline độc lập hoàn toàn**, không chia sẻ state hay thư mục:
*   **Work dir riêng cho từng đích:** `WORK_DIR/<queueKey>/<targetIndex>/` chứa cả clone nguồn lẫn checkout đích của riêng đích đó. **Không gom chung** thư mục xử lý → không có race, không đụng file nhau.
*   **Clone nguồn riêng:** mỗi đích tự shallow-clone nguồn về (đơn giản, an toàn tuyệt đối). Đánh đổi: clone lặp lại N lần cho N đích, nhưng shallow depth=1 nên chi phí thấp và đổi lấy cô lập hoàn toàn.
*   **Retry cục bộ:** clone/commit/push retry **bên trong** luồng đích, không leo ra ngoài.
*   **Song song có giới hạn:** chạy các luồng đích đồng thời với `TARGET_CONCURRENCY` (mặc định vừa phải để tránh rate limit). Dùng `Promise.allSettled` → 1 đích reject không làm hỏng đích khác.
*   **Trạng thái per-đích trong RTDB:** node queue giữ map `targets: { <target>: pending|processing|done|failed }`. Resume chỉ chạy lại đích chưa `done`, idempotency key kèm repo đích.
*   **Thứ tự vẫn giữ ở cấp queue:** dù các đích trong 1 event chạy song song, **các event vẫn xử lý tuần tự theo push key** (single-consumer) → thứ tự push toàn cục không đổi.
*   **Dọn dẹp:** xong (done/failed) thì xoá work dir của event để không phình đĩa.

* * *
## 3b. Chuẩn hoá hook data (GitHub + Azure)
Payload webhook của GitHub và Azure Repos khác cấu trúc. 1 lớp **normalizer** (`providers/*.ts`) map cả 2 về 1 model chung `NormalizedPush`, phần sau (validate/clone/push) chỉ làm việc với model này → xử lý được cả 2 nguồn.

**Model chung:**

```ts
interface NormalizedPush {
  provider: "github" | "azure";
  org: string;              // orgA | contoso
  repo: string;             // svc1  (dùng làm tên thư mục đích)
  fullName: string;         // orgA/svc1
  ref: string;              // refs/heads/main
  branch: string;           // main
  beforeSha: string;
  afterSha: string;         // commit để shallow clone
  cloneUrl: string;
  pusher: { name: string; email: string };
  headCommit: { message: string; author: { name: string; email: string } };
  deliveryId: string;       // idempotency
  raw: unknown;             // payload gốc để debug
}
```

Normalizer tự **detect provider** từ shape payload (hoặc field `_provider` do webhook đính kèm): GitHub có `repository.full_name` + `head_commit` + `pusher`; Azure có `resource.repository` + `resource.refUpdates` + `resource.pushedBy`.

**Mẫu hook GitHub (rút gọn):**

```json
{
  "ref": "refs/heads/main",
  "before": "9a1b...",
  "after": "3f2c...",
  "repository": {
    "name": "svc1",
    "full_name": "orgA/svc1",
    "owner": { "name": "orgA" },
    "clone_url": "https://github.com/orgA/svc1.git"
  },
  "pusher": { "name": "alice", "email": "alice@orgA.com" },
  "head_commit": {
    "id": "3f2c...",
    "message": "feat: add login",
    "author": { "name": "Alice", "email": "alice@orgA.com" }
  }
}
```

**Mẫu hook Azure Repos (****`git.push`****, rút gọn):**

```json
{
  "eventType": "git.push",
  "resource": {
    "refUpdates": [
      { "name": "refs/heads/main", "oldObjectId": "9a1b...", "newObjectId": "3f2c..." }
    ],
    "repository": {
      "name": "mirror",
      "project": { "name": "contoso" },
      "remoteUrl": "https://dev.azure.com/contoso/_git/mirror"
    },
    "pushedBy": {
      "displayName": "Alice",
      "uniqueName": "alice@contoso.com"
    },
    "commits": [
      { "commitId": "3f2c...", "comment": "feat: add login",
        "author": { "name": "Alice", "email": "alice@contoso.com" } }
    ]
  }
}
```

Mapping Azure → chung: `ref` ← `refUpdates[0].name`, `afterSha` ← `newObjectId`, `repo` ← `resource.repository.name`, `org` ← `project.name`, `cloneUrl` ← `remoteUrl`, `pusher` ← `pushedBy`, `headCommit` ← `commits[last]`. Thêm provider mới = thêm 1 normalizer + 1 bộ payload mẫu.

* * *
## 4\. Đảm bảo thứ tự & bền vững (điểm mấu chốt)
*   **FIFO:** dùng **push key** của Firebase (mã hoá timestamp + counter, **đảm bảo thứ tự** ghi) làm thứ tự. Node consumer luôn xử lý key nhỏ nhất ở trạng thái `pending`. Chỉ **1 consumer ở cấp event** (single-flight) để không đảo thứ tự giữa các push. Trong 1 event, các đích chạy song song nhưng không ảnh hưởng thứ tự toàn cục.
*   **Resume sau restart:** khi khởi động, Node quét `/sync-queue`, reset các node `processing` (treo do crash) về `pending`, rồi tiếp tục từ key nhỏ nhất chưa `done`. Với node `partial`, chỉ retry các đích chưa `done`.
*   **Realtime + catch-up:** vừa subscribe `child_added` cho event mới, vừa quét 1 lần ban đầu để cuốn hết backlog tồn đọng.
*   **Idempotency:** key = `delivery_id` (`X-GitHub-Delivery`) + `after` SHA + repo đích chống trùng. Đích đã `done` cùng key → skip (quan trọng khi retry 1 phần đích).
*   **At-least-once + idempotent = effectively-once.** Kiểm tra remote SHA từng đích trước khi commit lại để re-run không tạo commit rác.

* * *
## 5\. Cấu hình đa provider & token fallback
Hỗ trợ nhiều provider (`github`, `azure`...) và PAT có thể **riêng theo repo, chung theo org, hoặc global**. Khi cần token cho `org/repo`, resolver tìm theo thứ tự:

```plain
1. Token theo repo cụ thể:  TOKEN__<PROVIDER>__<ORG>__<REPO>
2. Không có → theo org:     TOKEN__<PROVIDER>__<ORG>
3. Không có nữa → global:   TOKEN__<PROVIDER>
4. Không có nữa → default:  TOKEN__DEFAULT
```

Ví dụ ENV token:

```env
# --- Global / mặc định ---
TOKEN__DEFAULT=                       # fallback cuối cùng
TOKEN__GITHUB=ghp_xxx                 # PAT chung cho mọi repo GitHub
TOKEN__AZURE=azdo_xxx                 # PAT chung cho mọi repo Azure

# --- Theo org ---
TOKEN__GITHUB__ORGA=ghp_orgA
TOKEN__AZURE__CONTOSO=azdo_contoso

# --- Theo repo cụ thể (ưu tiên cao nhất) ---
TOKEN__GITHUB__ORGA__SVC1=ghp_svc1_specific
TOKEN__AZURE__CONTOSO__PAYMENTS=azdo_payments_specific
```

Danh sách repo đích **phẳng** (áp cho mọi nguồn hợp lệ). Không map theo từng nguồn, không khai báo `dir` (thư mục = tên repo nguồn). Mỗi push hợp lệ join vào tất cả đích:

```env
# Danh sách repo đích chung
TARGETS=[
  {"provider":"github","repo":"orgA/mono","branch":"main"},
  {"provider":"github","repo":"orgA/backup-mono","branch":"main"},
  {"provider":"azure","repo":"contoso/mirror","branch":"main"}
]
```

**Filter repo nguồn (nhiều cấp rule):** repo khớp bất kỳ rule loại trừ nào sẽ **bị bỏ qua**, không clone/không push. Rule so trên tên repo (`repository.name` hoặc `org/repo`):

```env
# Mỗi rule: {type, value}. type ∈ startsWith | endsWith | equal
EXCLUDE_REPOS=[
  {"type":"startsWith","value":"test-"},
  {"type":"endsWith","value":"-sandbox"},
  {"type":"equal","value":"orgA/playground"}
]

# (tùy chọn) chỉ cho phép các repo khớp allowlist; để trống = cho tất cả trừ EXCLUDE
INCLUDE_REPOS=[]
```

Rule engine đặt ở 1 module riêng (`validators/`), mỗi loại rule là 1 hàm thuần, thêm loại mới (regex, glob...) chỉ cần thêm 1 case. Toàn bộ pipeline validate hook chạy trước khi clone.

Các ENV khác:

```env
# Firebase RTDB (điểm nhận webhook + queue)
FIREBASE_DB_URL=
FIREBASE_SERVICE_ACCOUNT=      # JSON hoặc path (để Node đọc/ghi status)
RTDB_QUEUE_PATH=/sync-queue

# Sync behaviour
SYNC_MODE=squash               # squash | replay
TARGET_CONCURRENCY=3           # số đích xử lý song song (giới hạn tránh rate limit)
CLONE_DEPTH=1                  # shallow clone depth (1 = nhanh nhất)
CLONE_MAX_RETRIES=3            # số lần reclone khi lỗi
CLONE_RETRY_BACKOFF_MS=2000    # backoff cơ sở (2s, 4s, 8s...)
COMMIT_MESSAGE_TEMPLATE="{message}\n\nSynced-From: {sourceRepo}@{shortSha}\nProvider: {provider}\nPushed-By: {pusherName} <{pusherEmail}>"
WORK_DIR=/tmp/repo-sync

# Logging
LOG_LEVEL=debug                # trace|debug|info|warn|error
LOG_FORMAT=json                # json | pretty
LOG_INCLUDE_PAYLOAD=false      # log full webhook payload (cẩn thận secret)
```

Mọi thứ động (đích, rule filter, token, clone depth, template, mức log) đều ở ENV; không hardcode. **Không còn** `ROUTES`/`SOURCE_REPOS` với `dir`, cũng **không còn** webhook secret vì không verify.

* * *
## 5c. Parse ENV JSON an toàn (base64 fallback → raw)
ENV dạng JSON (`TARGETS`, `EXCLUDE_REPOS`, `INCLUDE_REPOS`, `FIREBASE_SERVICE_ACCOUNT`...) rất dễ **vỡ** khi truyền qua shell/CI/Docker (nuốt dấu nháy, xuống dòng, ký tự đặc biệt). Chuẩn hoá 1 helper `parseJsonEnv(name)` với fallback nhiều bước:

1. Lấy raw value của biến.
2. **Thử decode base64 trước** (nếu match regex base64 hợp lệ): `Buffer.from(v, "base64").toString("utf8")` rồi `JSON.parse`. Nếu ok → dùng.
3. **Fallback về raw:** `JSON.parse(v)` trực tiếp trên chuỗi gốc.
4. Cả 2 fail → throw lỗi rõ ràng kèm tên biến + đoạn preview (không lộ token) để debug ngay.

Nhờ vậy config vừa dán JSON thô lúc dev, vừa dùng **base64-encoded** ở prod/CI cho an toàn (không vỡ). Khuyến nghị prod: encode `TARGETS`, `EXCLUDE_REPOS`, `FIREBASE_SERVICE_ACCOUNT` sang base64.

```env
# Cách 1 (dev): JSON thô
TARGETS=[{"provider":"github","repo":"orgA/mono","branch":"main"}]

# Cách 2 (prod/CI, khuyến nghị): base64 của cùng JSON trên
TARGETS=W3sicHJvdmlkZXIiOiJnaXRodWIiLCJyZXBvIjoib3JnQS9tb25vIiwiYnJhbmNoIjoibWFpbiJ9XQ==
```

Helper này áp cho **tất cả** ENV kiểu JSON. `config/env.ts` gọi `parseJsonEnv` rồi validate qua zod schema, lỗi shape sẽ báo ngay lúc khởi động (fail-fast).

* * *
## 5b. Log chi tiết
Structured logging (pino) với `seq`/`deliveryId` xuyên suốt để trace 1 event từ đầu tới cuối:
*   **Nhận event:** push key, `deliveryId`, `provider`, `sourceRepo`, `ref`, `commitCount`, số repo đích.
*   **Validate:** kết quả pipeline; nếu skip → log rõ rule nào khớp (startsWith/endsWith/equal) hoặc field nào thiếu.
*   **Token resolve:** log **cấp fallback** đã dùng (`repo` / `org` / `global` / `default`) cho nguồn và từng đích, KHÔNG log giá trị token.
*   **Clone:** repo nguồn, SHA, depth, thời gian clone, số lần reclone/retry, chiến lược fallback nếu shallow-by-SHA fail.
*   **Commit + Push (mỗi đích):** repo đích, target dir, message đã render, kết quả (ok / rebase-retry / failed), remote SHA trước–sau, số lần retry.
*   **Done/Partial/Failed/Skipped:** tổng thời gian, đích nào ok, đích nào lỗi, chuyển trạng thái RTDB.
*   **Resume:** log số node `processing` được reset, key bắt đầu, độ dài backlog.
*   **Lỗi:** stack trace + context đầy đủ, gắn push key + repo đích để đối chiếu.

`LOG_FORMAT=pretty` khi dev, `json` khi prod (đẩy vào log aggregator). `LOG_LEVEL=debug` bật chi tiết từng bước.

* * *
## 6\. Cấu trúc npm package

```plain
repo-sync/
├─ package.json          # bin: repo-sync, main: dist/index.js
├─ src/
│  ├─ index.ts           # programmatic API: createSyncService(config)
│  ├─ cli.ts             # CLI: repo-sync start | resume | status | smoke
│  ├─ listener.ts        # RTDB subscribe + quét backlog (KHÔNG http, KHÔNG verify)
│  ├─ queue/rtdb.ts      # push-key ordering, status transitions, resume, idempotency
│  ├─ worker.ts          # single-consumer FIFO theo push key
│  ├─ validators/        # index.ts (pipeline) + hookShape.ts + repoName.ts (startsWith/endsWith/equal)
│  ├─ providers/         # github.ts, azure.ts (normalizer -> NormalizedPush) + detect.ts
│  ├─ sync/git.ts        # shallow clone theo SHA + reclone/retry, copy, commit, push từng đích
│  ├─ config/tokens.ts   # resolver fallback repo→org→global→default
│  ├─ config/env.ts      # parseJsonEnv (base64→raw fallback) + zod validate
│  └─ logger.ts          # pino structured logging
├─ test/
│  ├─ fixtures/          # github-push.json, azure-push.json + biến thể lỗi
│  ├─ unit/              # env-parse, validators, token-fallback, normalizer, template
│  ├─ integration/       # queue resume, clone-retry, multi-target, idempotency
│  └─ smoke/             # tự spin service + bơm hook mẫu qua RTDB emulator
├─ README.md
└─ tsconfig.json
```

*   Publish public/scoped: `@your-org/repo-sync`.
*   Expose cả CLI (`npx repo-sync start`) lẫn API để nhúng.
*   Semantic versioning, `files` chỉ ship `dist/`.

* * *
## 7\. Kế hoạch thực hiện (milestones)
**M1 — Scaffold & config an toàn (1 ngày)**
*   Init TS package, build (tsup), logger pino. `parseJsonEnv` với **fallback base64 → raw** + zod validate, fail-fast. Unit test parse (JSON thô, base64, vỡ dấu nháy, lỗi → throw rõ ràng).

**M2 — Token resolver đa provider (1 ngày)**
*   Fallback `repo→org→global→default`, unit test đủ các nhánh fallback.

**M3 — Provider normalizer GitHub + Azure (1 ngày)**
*   Detect provider, map payload GitHub & Azure → `NormalizedPush`. Fixtures payload mẫu 2 provider + unit test mapping từng field.

**M4 — RTDB listener + durable queue (1.5 ngày)**
*   Webhook bắn thẳng vào RTDB path, subscribe `child_added`, quét backlog, ordering theo push key, idempotency, resume reset `processing`→`pending`. **Không HTTP, không verify.**

**M5 — Validator pipeline + filter rule (1 ngày)**
*   Module `validators/` tách rời: verify hook shape + verify tên repo theo `startsWith`/`endsWith`/`equal` (+ include allowlist). Interface `(event)=>{ok,reason}` dễ mở rộng. Unit test đủ các loại rule.

**M6 — Sync engine (shallow clone + đa đích song song, cô lập) (3 ngày)**
*   simple-git: **shallow clone** **`--depth`** **theo đúng SHA**, reclone + retry với backoff, fallback khi shallow-by-SHA fail. **Mỗi đích 1 work dir riêng** (clone nguồn riêng, copy ra checkout đích riêng, không gom chung), chạy song song có `TARGET_CONCURRENCY` qua `Promise.allSettled`, retry cục bộ trong luồng đích, trạng thái per-đích + partial/failed.

**M7 — Worker FIFO + resume (1 ngày)**
*   Single-consumer theo push key, mark status per-đích, khôi phục sau crash, không đảo thứ tự.

**M8 — Logging chi tiết (0.5 ngày)**
*   Trace theo push key qua mọi bước (validate → clone → từng đích), log rule skip + cấp token fallback, format json/pretty.

**M9 — CLI + smoke test (1 ngày)**
*   `repo-sync start|resume|status|smoke`. Lệnh `smoke` tự spin service + RTDB emulator, bơm hook mẫu GitHub & Azure, assert code chạy đúng vào đích. README.

**M10 — Test đầy đủ & hardening (2 ngày)**
*   Hoàn tất coverage theo Definition of Done (mục 8): unit từng case, integration, smoke 2 provider. Rate-limit, alerting, chuẩn bị `npm publish`.

**Tổng ước tính: ~13.5 ngày công.**

* * *
## 8\. Definition of Done (test là điều kiện hoàn thành)
Plan **chỉ được coi là xong** khi có đủ test, xanh hết trong CI:

**Unit (từng trường hợp):**
*   `parseJsonEnv`: JSON thô hợp lệ; base64 hợp lệ; chuỗi vỡ dấu nháy/xuống dòng (base64 cứu được); rác hoàn toàn → throw có tên biến.
*   Token resolver: hit ở cả 4 cấp `repo/org/global/default` + trường hợp không có token nào.
*   Validators: `startsWith`/`endsWith`/`equal` khớp → skip; không khớp → pass; allowlist; hook thiếu field.
*   Normalizer: GitHub payload & Azure payload → `NormalizedPush` đúng từng field; payload lạ → báo lỗi.
*   Commit message template render đúng các biến.

**Integration:**
*   Queue FIFO đúng thứ tự push key.
*   Kill service giữa chừng → resume đẩy tiếp commit chưa xong, **không trùng, không mất, đúng thứ tự**.
*   Clone lỗi → reclone/retry theo backoff; shallow-by-SHA fail → fallback thành công.
*   1 nguồn → nhiều đích: 1 đích fail → `partial`, retry riêng đích đó.
*   Idempotency: replay cùng `deliveryId`+SHA+đích → skip.

**Smoke (tự động):**
*   `repo-sync smoke` spin service + Firebase RTDB emulator, bơm **hook mẫu GitHub** và **hook mẫu Azure** vào path, assert: validate pass → shallow clone → push đúng thư mục = tên repo vào (các) đích. Chạy được trong CI không cần repo thật (dùng git remote local/bare).

* * *
## 9\. Rủi ro & cách xử lý (đã chốt)
*   **KHÔNG verify webhook** → ai biết URL cũng ghi được vào RTDB. **Xử lý:** khoá bằng **RTDB security rules** (chỉ cho ghi đúng path, cấm đọc/sửa/xoá) + auth token trong URL, rotate token định kỳ. Validator pipeline loại bỏ payload sai shape trước khi xử lý.
*   **Thứ tự push** → **đã chốt: dùng push key tự động của Firebase.** Push key (`-Nxxxx`) mã hoá timestamp + counter, **đảm bảo thứ tự** theo thời điểm ghi vào RTDB. Consumer xử lý theo key tăng dần là đủ, KHÔNG cần counter server-side. Bỏ hẳn lo ngại "lệch thứ tự".
*   **1 nguồn → nhiều đích** → **đã chốt: xử lý song song, cô lập hoàn toàn từng đích** (xem mục 3c). Mỗi đích tự clone nguồn về work dir riêng, copy ra thư mục riêng, commit + push + retry độc lập. 1 đích fail không đụng đích khác.
*   **Shallow clone theo SHA** → 1 số server không cho fetch sha lạ. **Xử lý:** thử `fetch --depth=1 <sha>` trước, fail thì fallback clone theo branch rồi `checkout <sha>`, cuối cùng tăng depth. Bọc reclone + retry backoff.
*   **Filter rule** → rule quá rộng chặn nhầm mọi repo. **Xử lý:** validate config lúc load (cấm rule rỗng nguy hiểm), log rõ repo bị skip vì rule nào; smoke test có case rule sai.
*   **Non-fast-forward** khi nhiều nguồn cùng ghi 1 đích → **Xử lý:** consumer đơn luồng theo push key nên các push tuần tự; trong 1 đích, trước khi push luôn `pull --rebase` remote đích, retry nếu vẫn lệch.
*   **Token fallback sai cấp** → **Xử lý:** log cấp đã resolve (không log giá trị); smoke/unit test phủ 4 cấp fallback để phát hiện sai quyền sớm.
*   **Rate limit / repo lớn** → **Xử lý:** shallow depth=1 tối thiểu dữ liệu; đích chạy song song có giới hạn concurrency (`TARGET_CONCURRENCY`) để không vượt rate limit.
*   **Force-push repo con** → v1 sync theo `after`. **Xử lý:** phát hiện `before` không phải ancestor → log cảnh báo, vẫn sync snapshot tại `after` (không rewrite history đích).
*   **Crash giữa lúc push 1 đích** → **Xử lý:** trạng thái per-đích trong RTDB + idempotency key (kèm repo đích) + kiểm tra remote SHA trước khi commit lại; resume chỉ chạy lại đích chưa `done`.
*   **Rác/ trùng trong RTDB queue** → **Xử lý:** node `done`/`skipped` được dọn (TTL hoặc move sang `/archive`) để queue không phình; resume bỏ qua node đã kết thúc.