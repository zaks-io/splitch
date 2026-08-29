export interface ConfigStoreMutationQueue {
  /** Operations must not call `run` again on this queue; nesting self-deadlocks. */
  run<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * Serializes complete D1-to-KV mutation sequences within one Environment's
 * writer Durable Object. Durable Object input gates reopen across external KV
 * I/O, so storage revision allocation alone cannot order the later KV writes.
 */
export function makeConfigStoreMutationQueue(): ConfigStoreMutationQueue {
  let tail = Promise.resolve();

  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      const result = tail.then(operation, operation);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
