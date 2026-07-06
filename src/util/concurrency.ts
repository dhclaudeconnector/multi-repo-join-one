/**
 * Run tasks with a bounded concurrency limit. Uses allSettled semantics: one
 * task rejecting never aborts the others.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  const max = Math.max(1, limit);
  let cursor = 0;

  async function runner(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        const value = await worker(items[index], index);
        results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  const runners = Array.from({ length: Math.min(max, items.length) }, () =>
    runner()
  );
  await Promise.all(runners);
  return results;
}
