import type { Provider } from "../types.js";

export type TokenLevel = "repo" | "org" | "global" | "default";

export interface ResolvedToken {
  token: string;
  level: TokenLevel;
  /** the ENV var name the token came from (for debug, never log value) */
  envKey: string;
}

/**
 * Normalize a segment for ENV key construction: uppercase, non-alnum -> "_".
 * e.g. "svc-1" -> "SVC_1", "orgA" -> "ORGA".
 */
export function normalizeSegment(s: string): string {
  return s
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Resolve a PAT for a given provider/org/repo using the fallback chain:
 *   1. TOKEN__<PROVIDER>__<ORG>__<REPO>   (repo-specific, highest priority)
 *   2. TOKEN__<PROVIDER>__<ORG>           (org level)
 *   3. TOKEN__<PROVIDER>                  (global for provider)
 *   4. TOKEN__DEFAULT                     (final fallback)
 *
 * Returns null if no non-empty token is found at any level.
 */
export function resolveToken(
  env: NodeJS.ProcessEnv,
  provider: Provider,
  org: string,
  repo: string
): ResolvedToken | null {
  const P = normalizeSegment(provider);
  const O = normalizeSegment(org);
  const R = normalizeSegment(repo);

  const candidates: Array<{ key: string; level: TokenLevel }> = [
    { key: `TOKEN__${P}__${O}__${R}`, level: "repo" },
    { key: `TOKEN__${P}__${O}`, level: "org" },
    { key: `TOKEN__${P}`, level: "global" },
    { key: `TOKEN__DEFAULT`, level: "default" },
  ];

  for (const { key, level } of candidates) {
    const val = env[key];
    if (val != null && val.trim() !== "") {
      return { token: val.trim(), level, envKey: key };
    }
  }

  return null;
}

/**
 * Build an authenticated clone/push URL by injecting the token.
 * Works for GitHub (x-access-token) and Azure (pat as password).
 * Returns the original url unchanged if it isn't http(s).
 */
export function authenticateUrl(
  url: string,
  token: string,
  provider: Provider
): string {
  if (!/^https?:\/\//i.test(url)) return url;
  try {
    const u = new URL(url);
    if (provider === "github") {
      u.username = "x-access-token";
      u.password = token;
    } else {
      // Azure DevOps accepts any username with the PAT as password.
      u.username = "pat";
      u.password = token;
    }
    return u.toString();
  } catch {
    return url;
  }
}
