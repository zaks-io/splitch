import type { KvReader } from "./kv-provider.js";

/**
 * A fake KV for read-side tests ONLY. It holds pre-seeded raw STRING values
 * (exactly what real KV `get` returns) keyed by the app-scoped key, plus a hook to
 * seed deliberately malformed blobs. It counts `get` calls per key so a test can
 * assert getFlag makes ONE read (no second lookup for the experiment).
 *
 * It implements nothing of the platform write path — there is no `put`. This is
 * the fixture substrate the Provider reads against; tests never invoke a writer.
 */
export class FakeKv implements KvReader {
  private readonly store = new Map<string, string>();
  readonly getCalls: string[] = [];

  /** Seed a raw JSON string under a key (caller controls the exact bytes). */
  putRaw(key: string, rawJson: string): this {
    this.store.set(key, rawJson);
    return this;
  }

  /** Seed a value by serializing it through the schema-version envelope. */
  put(key: string, value: unknown, schemaVersion = 1): this {
    return this.putRaw(key, JSON.stringify({ schemaVersion, data: value }));
  }

  get(key: string): Promise<string | null> {
    this.getCalls.push(key);
    return Promise.resolve(this.store.get(key) ?? null);
  }

  list(options: { prefix: string }): Promise<{ keys: { name: string }[] }> {
    const keys = [...this.store.keys()]
      .filter((name) => name.startsWith(options.prefix))
      .map((name) => ({ name }));
    return Promise.resolve({ keys });
  }

  /** Count of `get` calls whose key contains the given substring. */
  getCallsMatching(substring: string): number {
    return this.getCalls.filter((k) => k.includes(substring)).length;
  }
}
