export const DEFAULT_OPERATION_CONCURRENCY = 4;

export interface BoundedMapOptions {
  concurrency?: number;
  signal?: AbortSignal;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("Operation aborted", "AbortError");
}

/**
 * Maps work through a fixed number of runners instead of allocating one promise
 * per item. Results retain input ordering, while runners stop claiming work as
 * soon as a task fails or the supplied signal is aborted.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number, signal?: AbortSignal) => Promise<R>,
  options: BoundedMapOptions = {},
): Promise<R[]> {
  const concurrency = options.concurrency ?? DEFAULT_OPERATION_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive integer");
  }
  if (options.signal?.aborted) throw abortError(options.signal);
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;

  async function run() {
    while (!failed) {
      if (options.signal?.aborted) {
        failed = true;
        failure = abortError(options.signal);
        return;
      }

      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index]!, index, options.signal);
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
  }

  const runnerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: runnerCount }, run));
  if (failed) throw failure;
  return results;
}
