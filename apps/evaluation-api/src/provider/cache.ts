import type { DeltaNudge } from "@splitch/contracts";
import type { FlagConfig } from "./provider.js";

/**
 * The Provider's ONLY state: an invalidatable cache of resolved flag config
 * (ADR-0007). Entries are keyed by the full app-scoped KV key, so an entry for
 * App A can never be returned for App B — tenant isolation rides on the key.
 *
 * Draft exclusion is an UPSTREAM invariant, not enforced here: KV only ever holds
 * live flag config (drafts live in D1 until promoted), so every value the Provider
 * reads and caches is already live. The cache does not itself inspect liveness —
 * it caches what the KV read produced.
 *
 * A WebSocket DeltaNudge (ADR-0019) invalidates the affected App's entries so the
 * next read re-fetches. The DO is per-App, so the nudge's App is implied by the
 * connection and passed in by the caller.
 */
export class FlagConfigCache {
  private readonly entries = new Map<string, FlagConfig>();

  get(kvKey: string): FlagConfig | undefined {
    return this.entries.get(kvKey);
  }

  /**
   * Cache a resolved FlagConfig under its app-scoped KV key. The cached value is
   * whatever the KV read produced; since KV holds only live config, only live
   * config is ever cached (draft exclusion is the writer's invariant, above).
   */
  set(kvKey: string, config: FlagConfig): void {
    this.entries.set(kvKey, config);
  }

  /**
   * Invalidate every entry for one App on a DeltaNudge. The DO that broadcasts the
   * nudge is per-App, so `appId` comes from the WebSocket connection, not the
   * nudge body (which is schema-opaque and carries only the changed entity id).
   * Any `config.changed` nudge re-fetches the App's config on next read; we do not
   * try to map an entity id to individual flag keys (the spec invalidates at App
   * granularity, then re-fetches).
   */
  invalidateApp(appId: string, _nudge: DeltaNudge): void {
    const prefix = `app:${appId}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  /** Drop a single entry by its app-scoped KV key. */
  invalidateKey(kvKey: string): void {
    this.entries.delete(kvKey);
  }

  /** Test/observability aid: number of cached entries. */
  get size(): number {
    return this.entries.size;
  }
}
