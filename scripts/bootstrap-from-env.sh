#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.deploy/env.prod}"
if [ ! -f "$ENV_FILE" ]; then
  echo "ENV file not found: $ENV_FILE" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

need() {
  local name="$1"
  if [ -z "${!name:-}" ] || [[ "${!name}" == YOUR_* ]] || [[ "${!name}" == *PASTE_* ]]; then
    echo "Missing or placeholder value: $name" >&2
    exit 2
  fi
}

need GITHUB_SOURCE_ORG
need RTDB_WEBHOOK_URL
need GITHUB_ADMIN_TOKEN

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required for GitHub API/bootstrap. Install: https://cli.github.com/" >&2
  exit 2
fi

export GH_TOKEN="$GITHUB_ADMIN_TOKEN"

echo "Checking existing GitHub org webhooks for $GITHUB_SOURCE_ORG ..."
HOOK_ID="$(gh api "/orgs/$GITHUB_SOURCE_ORG/hooks" --jq ".[] | select(.config.url == \"$RTDB_WEBHOOK_URL\") | .id" | head -n1 || true)"

if [ -n "$HOOK_ID" ]; then
  echo "Webhook already exists: id=$HOOK_ID. Updating it."
  gh api --method PATCH "/orgs/$GITHUB_SOURCE_ORG/hooks/$HOOK_ID" \
    -f name=web \
    -f active=true \
    -f events[]=push \
    -f config[url]="$RTDB_WEBHOOK_URL" \
    -f config[content_type]=json \
    -f config[insecure_ssl]=0 >/dev/null
else
  echo "Creating GitHub org webhook..."
  gh api --method POST "/orgs/$GITHUB_SOURCE_ORG/hooks" \
    -f name=web \
    -f active=true \
    -f events[]=push \
    -f config[url]="$RTDB_WEBHOOK_URL" \
    -f config[content_type]=json \
    -f config[insecure_ssl]=0 >/dev/null
fi

echo "GitHub org webhook ready."

# Optional: set GitHub Actions secrets on the current repository if gh knows it.
CURRENT_REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
if [ -n "$CURRENT_REPO" ]; then
  echo "Setting GitHub Actions secrets on $CURRENT_REPO when values are present..."
  [ -n "${FIREBASE_SERVICE_ACCOUNT_B64:-}" ] && gh secret set FIREBASE_SERVICE_ACCOUNT_B64 --body "$FIREBASE_SERVICE_ACCOUNT_B64" --repo "$CURRENT_REPO"
  [ -n "${SYNC_GITHUB_TOKEN:-}" ] && gh secret set SYNC_GITHUB_TOKEN --body "$SYNC_GITHUB_TOKEN" --repo "$CURRENT_REPO"
  [ -n "${SYNC_AZURE_TOKEN:-}" ] && gh secret set SYNC_AZURE_TOKEN --body "$SYNC_AZURE_TOKEN" --repo "$CURRENT_REPO"
  [ -n "${GH_ADMIN_TOKEN:-}" ] && gh secret set GH_ADMIN_TOKEN --body "$GH_ADMIN_TOKEN" --repo "$CURRENT_REPO"
else
  echo "Not inside a GitHub repo, skipping gh secret set."
fi

# Optional Azure variable setup. Requires az devops extension.
if command -v az >/dev/null 2>&1 && [ -n "${AZURE_DEVOPS_ORG:-}" ] && [ -n "${AZURE_DEVOPS_PROJECT:-}" ]; then
  echo "Azure CLI detected. Configure pipeline secrets manually or extend this script with your variable group id."
  echo "Recommended variables: FIREBASE_SERVICE_ACCOUNT_B64, SYNC_GITHUB_TOKEN, SYNC_AZURE_TOKEN, GH_ADMIN_TOKEN"
fi

echo "Bootstrap complete."
