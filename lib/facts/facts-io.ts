/** Drain all active IO before rejection so callers may safely release a lock. */
export async function mapFactsIO<T, R>(
  items: readonly T[],
  operation: (item: T, signal: AbortSignal) => Promise<R>,
  signal?: AbortSignal,
  concurrency = 8,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new RangeError("Facts IO concurrency must be between 1 and 32");
  }
  signal?.throwIfAborted();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (next < items.length && !combined.aborted) {
      const index = next++;
      try {
        results[index] = await operation(items[index], combined);
      } catch (error) {
        if (!failure) failure = { error };
        controller.abort(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  signal?.throwIfAborted();
  if (failure) throw failure.error;
  return results;
}
