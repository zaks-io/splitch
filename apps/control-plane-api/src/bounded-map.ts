/**
 * Order-preserving bounded map. Stops pulling work after the first failure and
 * rethrows it, so a dead downstream boundary costs one pool's worth of reads
 * instead of one read per item.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  const queue = [...items.entries()];
  let cursor = 0;
  let failure: { cause: unknown } | undefined;

  const worker = async (): Promise<void> => {
    for (
      let entry = queue[cursor++];
      entry !== undefined && failure === undefined;
      entry = queue[cursor++]
    ) {
      const [index, item] = entry;
      try {
        out[index] = await run(item);
      } catch (cause) {
        failure ??= { cause };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, () => worker()));
  if (failure) throw failure.cause;
  return out;
}
