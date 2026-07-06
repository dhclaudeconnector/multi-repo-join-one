import type { NormalizedPush, ValidationResult } from "../types.js";

/**
 * Ensure the normalized push has the minimum required fields to proceed.
 * Missing anything -> skip (not an error, just not actionable).
 */
export function validateHookShape(push: NormalizedPush): ValidationResult {
  const missing: string[] = [];
  if (!push.repo) missing.push("repo");
  if (!push.afterSha) missing.push("afterSha");
  if (!push.ref) missing.push("ref");
  if (!push.cloneUrl) missing.push("cloneUrl");

  if (missing.length > 0) {
    return { ok: false, reason: `hook missing fields: ${missing.join(", ")}` };
  }
  return { ok: true };
}
