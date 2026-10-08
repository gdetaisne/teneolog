/**
 * Bounded-concurrency map that preserves output order.
 *
 * Spawns at most `limit` workers. Each worker picks the next unclaimed item
 * index and writes to that slot — so results[i] always corresponds to items[i]
 * regardless of completion order.
 *
 * It lived inside `candidates.ts` until `discovery.ts` needed exactly the same
 * bound on exactly the same port. One copy, one behaviour.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}
