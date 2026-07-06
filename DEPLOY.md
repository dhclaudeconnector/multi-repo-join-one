# DEPLOY.md - triển khai multi-repo-join-one

Tài liệu này đi theo mô hình bạn yêu cầu:

```text
GitHub org webhook -> Firebase RTDB /sync-queue -> GitHub Actions chạy mỗi 60 phút
                                      \-> sync vào GitHub repo cá nhân
                                       \-> sync vào Azure Repo
```

Service **không mở HTTP server**. GitHub webhook POST trực tiếp vào Firebase Realtime Database REST endpoint. Job CI chạy service, drain queue trong khoảng thời gian giới hạn, ghi log artifact, rồi lần kế tiếp chạy lại sau 60 phút.

## 1. Chuẩn bị

Cần có:

- Node.js >= 18.
- Firebase Realtime Database project.
- Firebase service account JSON cho service đọc/ghi queue status.
- GitHub org chứa repo nguồn.
- GitHub target repo cá nhân, ví dụ `username/personal-mono`.
- Azure DevOps repo đích, ví dụ `org/project/_git/repo`.
- GitHub token runtime có quyền read source repo và write target repo.
- Azure PAT runtime có quyền Code Read & Write target repo.

## 2. Firebase RTDB

Tạo RTDB, sau đó tạo service account:

```text
Firebase Console -> Project settings -> Service accounts -> Generate new private key
```

Production nên lưu service account dạng base64:

```bash
base64 -w0 firebase-service-account.json
```

Trên macOS:

```bash
base64 -i firebase-service-account.json | tr -d '\n'
```

Webhook URL cho GitHub org có dạng:

```text
https://YOUR_FIREBASE_PROJECT-default-rtdb.firebaseio.com/sync-queue.json?auth=YOUR_RTDB_WRITE_TOKEN
```

RTDB rules gợi ý tối thiểu:

```json
{
  "rules": {
    "sync-queue": {
      ".read": false,
      "$id": {
        ".write": "auth != null",
        ".validate": "newData.isObject()"
      }
    },
    "archive": {
      ".read": false,
      ".write": "auth != null"
    }
  }
}
```

Nếu dùng URL `?auth=...`, hãy dùng token có quyền ghi đúng path và rotate định kỳ.

## 3. Cấu hình env.prod

File mẫu nằm ở:

```text
.deploy/env.prod
```

Bạn cần sửa tối thiểu các biến:

```text
FIREBASE_DB_URL
FIREBASE_SERVICE_ACCOUNT
TARGETS
TOKEN__GITHUB
TOKEN__AZURE
GITHUB_SOURCE_ORG
RTDB_WEBHOOK_URL
CHECK_SOURCE_REPOS
```

Lưu ý về token trong file mẫu: placeholder được viết kiểu `"""..."""` hoặc không giống token thật để tránh GitHub secret scanning chặn push. Khi chạy thật trên GitHub Actions, nên dùng repository secrets, không commit token thật vào `env.prod`.

## 4. GitHub Actions chạy mỗi 60 phút

Workflow có sẵn:

```text
.github/workflows/repo-sync-hourly.yml
```

Cần tạo GitHub repository secrets:

```text
FIREBASE_SERVICE_ACCOUNT_B64  base64 của service account JSON
SYNC_GITHUB_TOKEN             token runtime GitHub
SYNC_AZURE_TOKEN              Azure DevOps PAT
GH_ADMIN_TOKEN                token dùng bootstrap webhook/secrets nếu cần
```

Workflow dùng `timeout-minutes: 59` và chạy service khoảng 55 phút. Sau đó job kết thúc, upload artifact log. Lần kế tiếp scheduler chạy lại sau 60 phút, tương đương restart định kỳ.

Chạy thủ công:

```text
GitHub repo -> Actions -> Repo Sync Hourly -> Run workflow
```

## 5. Azure Pipelines

File có sẵn:

```text
azure-pipelines.yml
```

Cần tạo secret variables trong Azure Pipeline Library hoặc pipeline variables:

```text
FIREBASE_SERVICE_ACCOUNT_B64
SYNC_GITHUB_TOKEN
SYNC_AZURE_TOKEN
GH_ADMIN_TOKEN
```

Pipeline cũng chạy định kỳ 60 phút và publish log artifact.

## 6. Bootstrap qua API/CLI

Script có sẵn:

```text
scripts/bootstrap-from-env.sh
```

Script đọc `.deploy/env.prod`, rồi:

- tạo/cập nhật GitHub org webhook trỏ vào `RTDB_WEBHOOK_URL`;
- set GitHub Actions secrets nếu có `gh` CLI;
- set Azure Pipeline variables nếu có `az` CLI và bạn bật phần tương ứng.

Chạy:

```bash
chmod +x scripts/bootstrap-from-env.sh
scripts/bootstrap-from-env.sh .deploy/env.prod
```

Yêu cầu local tool:

```text
gh auth login
az login
```

Hoặc truyền token qua env như trong `env.prod`.

## 7. Kiểm tra output từ artifact và env.prod

Script:

```text
scripts/check-output.js
```

Chức năng:

- đọc `.deploy/env.prod`;
- đọc artifact log nếu truyền vào;
- lấy danh sách source từ `CHECK_SOURCE_REPOS`;
- lấy target từ `TARGETS`;
- clone/fetch shallow các repo;
- đếm commit, số file tracked, tổng bytes;
- kiểm tra trong target có thư mục trùng tên repo nguồn;
- xuất JSON report.

Chạy:

```bash
node scripts/check-output.js --env .deploy/env.prod --artifact artifacts/repo-sync.log --out artifacts/check-report.json
```

Output mẫu:

```json
{
  "ok": true,
  "sources": [{ "repo": "org/svc-api", "commitCount": 120, "fileCount": 42 }],
  "targets": [{ "repo": "username/personal-mono", "fileCount": 100 }],
  "checks": [{ "source": "org/svc-api", "target": "username/personal-mono", "targetDirExists": true }]
}
```

## 8. Chạy local nhanh

```bash
npm ci
npm run build
set -a
source .deploy/env.prod
set +a
node dist/cli.js status
node dist/cli.js start
```

Nếu muốn test self-contained không cần Firebase thật:

```bash
npm run smoke
```

Nếu muốn test RTDB emulator:

```bash
npm run setup:rtdb-emulator
npm run test:smoke:rtdb
```

## 9. Lưu ý vận hành

- Code hiện tại sync kiểu **squash snapshot**: file cuối cùng đúng theo `afterSha`, nhưng không replay lịch sử commit gốc.
- Không commit token thật vào repo.
- Job chạy lại mỗi 60 phút nên queue cần durable. Item `processing` bị crash sẽ được reset về `pending` khi service start.
- Nếu 1 target fail, item có thể thành `partial`; lần restart sau sẽ retry target chưa `done`.
- Artifact log là nguồn chính để debug từng event/target.
