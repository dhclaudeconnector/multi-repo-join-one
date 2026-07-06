import type { NormalizedPush, Provider } from "../types.js";
import { normalizeGithub } from "./github.js";
import { normalizeAzure } from "./azure.js";

/**
 * Detect the provider from a raw webhook payload shape.
 *   - explicit `_provider` field wins (webhook may attach it)
 *   - GitHub: has repository.full_name + head_commit + pusher
 *   - Azure:  has resource.repository + resource.refUpdates + resource.pushedBy
 */
export function detectProvider(raw: any): Provider {
  if (raw && typeof raw === "object") {
    if (raw._provider === "github" || raw._provider === "azure") {
      return raw._provider;
    }
    if (raw.eventType === "git.push" || raw.resource?.refUpdates) {
      return "azure";
    }
    if (raw.repository?.full_name || raw.head_commit || raw.pusher) {
      return "github";
    }
    if (raw.repository?.clone_url) {
      return "github";
    }
  }
  throw new Error("cannot detect provider from payload shape");
}

/**
 * Normalize any supported provider payload into NormalizedPush.
 */
export function normalize(raw: any, deliveryId?: string): NormalizedPush {
  const provider = detectProvider(raw);
  switch (provider) {
    case "github":
      return normalizeGithub(raw, deliveryId);
    case "azure":
      return normalizeAzure(raw, deliveryId);
    default: {
      const _exhaustive: never = provider;
      throw new Error(`unsupported provider: ${_exhaustive}`);
    }
  }
}

export { normalizeGithub, normalizeAzure };
