/**
 * Readers-writer section for the privacy Durable Objects.
 *
 * Delivery and a privacy reset must never overlap: a reset that purged while a
 * delivery it already admitted was mid-Tinybird would let a deleted row land
 * after the deletion proof. The obvious way to get that is one mutex over every
 * request, which is what this replaces. The App-identity inventory is a single
 * object per App, so a mutex held across the Tinybird round trip capped one
 * App's entire ingest at one event per round trip, worldwide. Cloudflare names
 * holding a Durable Object lock across `fetch()` an anti-pattern for exactly
 * this reason:
 * https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
 * Queue-backed microbatches cannot retain a request section across their
 * cross-authority append, so they extend this invariant with durable delivery
 * permits instead.
 *
 * Deliveries only need to exclude a reset, not each other, so they take the
 * shared side and run concurrently. A reset takes the exclusive side: it waits
 * for every admitted delivery to finish before it purges, which is the same
 * guarantee the mutex gave. Writers are preferred, so a busy App cannot starve
 * a privacy reset.
 */
export class DeliveryResetLock {
  private writers = 0;
  private writerQueue: Promise<unknown> = Promise.resolve();
  private readonly readers = new Set<Promise<unknown>>();

  /** Runs concurrently with other shared sections; excluded by an exclusive one. */
  async shared<T>(run: () => Promise<T>): Promise<T> {
    // Re-read each pass: a second writer may have queued while awaiting the first.
    while (this.writers > 0) {
      await settled(this.writerQueue);
    }
    const running = run();
    this.readers.add(running);
    try {
      return await running;
    } finally {
      this.readers.delete(running);
    }
  }

  /** Runs alone: after every earlier writer, and after every admitted reader drains. */
  async exclusive<T>(run: () => Promise<T>): Promise<T> {
    // Claimed synchronously, before the first await, so a reader that checks
    // `writers` in this same turn already sees the writer and yields to it.
    this.writers += 1;
    const earlier = this.writerQueue;
    let release!: () => void;
    this.writerQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await settled(earlier);
      while (this.readers.size > 0) {
        await Promise.allSettled([...this.readers]);
      }
      return await run();
    } finally {
      this.writers -= 1;
      release();
    }
  }
}

/** A failed section still releases the lock; the caller sees the rejection. */
function settled(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}
