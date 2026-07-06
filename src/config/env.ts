/**
 * Safe ENV JSON parsing with base64 -> raw fallback.
 *
 * JSON in ENV (TARGETS, EXCLUDE_REPOS, INCLUDE_REPOS, FIREBASE_SERVICE_ACCOUNT...)
 * easily breaks when passed through shell/CI/Docker (eaten quotes, newlines,
 * special chars). `parseJsonEnv` normalizes this:
 *   1. read raw value
 *   2. try base64 decode first (if it looks like base64) then JSON.parse
 *   3. fallback to JSON.parse on the raw string
 *   4. both fail -> throw a clear error with the var name + a safe preview
 */

/** Matches a plausible base64 string (length multiple of 4, base64 alphabet). */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function looksLikeBase64(v: string): boolean {
  const s = v.trim();
  if (s.length < 4 || s.length % 4 !== 0) return false;
  if (!BASE64_RE.test(s)) return false;
  // A raw JSON value starts with { [ " or a digit/letter; base64 of JSON never
  // starts with { or [. This cheap guard avoids trying to base64-decode obvious
  // raw JSON.
  if (s.startsWith("{") || s.startsWith("[")) return false;
  return true;
}

/** Produce a short, secret-safe preview of a value for error messages. */
function preview(v: string, max = 40): string {
  const s = v.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… (${s.length} chars)`;
}

export class EnvParseError extends Error {
  constructor(name: string, value: string, cause?: unknown) {
    super(
      `Failed to parse ENV "${name}" as JSON (tried base64 then raw). ` +
        `Value preview: ${preview(value)}`
    );
    this.name = "EnvParseError";
    if (cause instanceof Error) this.stack += `\nCaused by: ${cause.stack}`;
  }
}

/**
 * Parse a JSON ENV variable with base64->raw fallback.
 *
 * @param name    the ENV var name (for errors)
 * @param rawValue the value to parse; if omitted, read from process.env[name]
 * @param fallback returned when the var is unset/empty
 */
export function parseJsonEnv<T = unknown>(
  name: string,
  rawValue?: string | undefined,
  fallback?: T
): T {
  const raw = rawValue ?? process.env[name];

  if (raw == null || raw.trim() === "") {
    if (fallback !== undefined) return fallback;
    throw new EnvParseError(name, "<empty>");
  }

  const value = raw.trim();

  // 1) Try base64 first when it plausibly is base64.
  if (looksLikeBase64(value)) {
    try {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      // guard: base64 round-trip must reproduce the input to be considered valid
      const reencoded = Buffer.from(decoded, "utf8").toString("base64");
      if (reencoded.replace(/=+$/, "") === value.replace(/=+$/, "")) {
        return JSON.parse(decoded) as T;
      }
    } catch {
      // fall through to raw parse
    }
  }

  // 2) Fallback: parse raw string directly.
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    throw new EnvParseError(name, value, err);
  }
}

/**
 * Encode a JSON-serializable value to base64 (helper for producing prod ENV).
 */
export function encodeJsonEnv(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}
