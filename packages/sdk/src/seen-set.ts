import type { VariantValue } from "./generated/contract-surface.js";
import { SplitchSdkError } from "./errors";

/**
 * Per-instance in-memory Exposure dedup cache (docs/spec/sdk/seen-set.md). It is
 * a hot-path wire optimization ONLY — the pipeline dedup is the authority. Its job
 * is to short-circuit a repeat `evaluate` for the same Entity/Run so no redundant
 * transport call and no redundant Exposure fire (`reason: CACHED`).
 *
 * Key = (flagKey, runId, idType, targetingKey). `runId` is required so a
 * Run-boundary re-evaluation is NOT wrongly suppressed: a new Run stores a new
 * entry, and the prior one no longer matches (seen-set.md §"Seen-set key").
 * `idType` is required because Entity identity is (idType, targetingKey) — two
 * Entities of different types sharing a bare key ("user 42" vs "workspace 42")
 * must not replay each other's Variant.
 *
 * Bounded optimistic suppression (the real guarantee for a pure HTTP client).
 * The bare wire body carries no runId, so the SDK cannot know the *current* runId
 * before a call — it can only remember the runId of the last resolution for an
 * (flagKey, idType, targetingKey). If it short-circuited on that stale runId forever, a
 * long-lived instance (browser SPA, warm Worker) would NEVER detect a new Run and
 * would under-count the new Run's denominator. So each entry carries a timestamp
 * and a hit is valid only within a revalidation window (`ttlMs`): a same-Run
 * repeat within the window short-circuits (dedup preserved); past the window the
 * SDK re-contacts the server, which returns the current runId via X-Run-Id, and a
 * new runId there is a fresh Exposure under the new Run. A Run boundary is thus
 * detected within at most `ttlMs`, never "never". The window mirrors the ~60s KV
 * config-propagation window the platform already tolerates (five-runtimes.md).
 *
 * Eviction is LRU: a `get` hit and a `set` both mark the key most-recently-used
 * (Map preserves insertion order, so delete+set moves the key to the tail). At
 * capacity the oldest (head) entry is evicted; an evicted key causes at most one
 * redundant Exposure, which the pipeline collapses.
 */

const DEFAULT_SEEN_SET_MAX_SIZE = 10_000;
// Matches the ~60s KV propagation window the platform already tolerates.
export const DEFAULT_REVALIDATE_MS = 60_000;

export interface SeenEntry {
  readonly runId: string;
  /**
   * The WIRE variant of the cached resolution. `null` records a 200 no-match
   * (reason DEFAULT) — the replay must re-apply the CURRENT call's Default
   * Variant, never a previous caller's, so the caller-supplied default is not
   * stored here.
   */
  readonly variant: VariantValue | null;
  /** Epoch ms when this entry was written; the TTL is measured from here. */
  readonly storedAt: number;
}

function entryId(flagKey: string, idType: string, targetingKey: string): string {
  // Joined with NUL (escaped): the one byte the components will not contain,
  // so no two distinct (flagKey, idType, targetingKey) triples can collide.
  return `${flagKey}\u0000${idType}\u0000${targetingKey}`;
}

export class SeenSet {
  // Keyed by (flagKey, idType, targetingKey); the entry carries the runId +
  // storedAt so a lookup can confirm the run has not advanced AND the entry is
  // still fresh.
  private readonly entries = new Map<string, SeenEntry>();

  constructor(
    private readonly maxSize: number = DEFAULT_SEEN_SET_MAX_SIZE,
    private readonly ttlMs: number = DEFAULT_REVALIDATE_MS,
  ) {
    if (maxSize < 1) {
      // Fail loud: a zero/negative cache is a misconfiguration, not a silent no-op.
      throw new SplitchSdkError({
        code: "SDK_SEEN_SET_MAX_SIZE_INVALID",
        cause: `The seen-set maxSize must be at least 1 but received ${maxSize}`,
        remediation: "Set seenSetMaxSize to a positive integer",
      });
    }
    if (ttlMs < 0) {
      throw new SplitchSdkError({
        code: "SDK_SEEN_SET_TTL_INVALID",
        cause: `The seen-set ttlMs must be at least 0 but received ${ttlMs}`,
        remediation: "Set revalidateMs to 0 or a positive duration in milliseconds",
      });
    }
  }

  /**
   * The cached entry for this (flagKey, idType, targetingKey) when it is still
   * within the revalidation window, or `undefined` on a miss (never seen, OR the
   * entry has aged past `ttlMs` and must be revalidated against the server). A
   * hit is an LRU touch. `now` is injected (the caller passes the clock) so the
   * TTL is testable without real time.
   */
  get(flagKey: string, idType: string, targetingKey: string, now: number): SeenEntry | undefined {
    const id = entryId(flagKey, idType, targetingKey);
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return undefined;
    }
    if (now - entry.storedAt >= this.ttlMs) {
      // Stale: force a revalidation so a Run boundary is detected within the TTL.
      this.entries.delete(id);
      return undefined;
    }
    // Re-insert to move the key to the most-recently-used tail.
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry;
  }

  /**
   * Record a resolved Variant under its runId. NEVER call this for an ERROR result
   * — caching a failure-fallback would mask a later real resolution (ADR-0036).
   * The caller in evaluate.ts only reaches this on a successful resolution.
   */
  set(
    flagKey: string,
    runId: string,
    idType: string,
    targetingKey: string,
    variant: VariantValue | null,
    now: number,
  ): void {
    const id = entryId(flagKey, idType, targetingKey);
    this.entries.delete(id);
    this.entries.set(id, { runId, variant, storedAt: now });
    if (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
