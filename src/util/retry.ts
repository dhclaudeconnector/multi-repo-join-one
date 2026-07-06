export interface RetryOptions {
  retries: number;
  /** base backoff in ms; delay = baseMs * 2^(attempt-1) */
  baseMs: number;
  /** called before each retry (not on the first attempt) */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  /** predicate: return false to stop retrying a given error */
  shouldRetry?: (err: unknown) => boolean;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` with exponential backoff. Attempts = retries + 1 (initial try).
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions
): Promise<T> {
  const total = Math.max(0, opts.retries) + 1;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= total; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (opts.shouldRetry && !opts.shouldRetry(err)) throw err;
      if (attempt >= total) break;
      const delayMs = opts.baseMs * 2 ** (attempt - 1);
      opts.onRetry?.(attempt, delayMs, err);
      await delay(delayMs);
    }
  }

  throw lastErr;
}
