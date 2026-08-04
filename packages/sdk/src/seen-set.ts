import type { VariantValue } from "./generated/contract-surface.js";
import { SplitchSdkError } from "./errors";
import type { AttributeValue } from "./transport";

/**
 * Per-instance in-memory Exposure dedup cache (docs/spec/sdk/seen-set.md). It is
 * a hot-path wire optimization ONLY — the pipeline dedup is the authority. Its job
 * is to short-circuit a repeat `evaluate` for the same Entity/Run so no redundant
 * transport call and no redundant Exposure fire (`reason: CACHED`).
 *
 * Two keys, deliberately:
 * - Exposure identity = (flagKey, runId, idType, targetingKey). One Exposure per
 *   Entity/Run regardless of Evaluation Context churn.
 * - Value replay = that identity plus a stable fingerprint of `attributes`. A
 *   cached Variant is valid only for the attribute set that produced it; a
 *   different context must re-resolve (without a second Exposure while the
 *   Exposure entry is still fresh).
 *
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
 * Eviction is LRU at two levels: a `get` hit and a `set` both mark the Exposure
 * identity most-recently-used (Map preserves insertion order, so delete+set
 * moves the key to the tail). At capacity the oldest (head) Exposure entry is
 * evicted; an evicted key causes at most one redundant Exposure, which the
 * pipeline collapses. Within one Exposure slot, attribute-fingerprint values
 * are also LRU-capped so high-cardinality context churn cannot grow unbounded
 * inside a single TTL window.
 */

const DEFAULT_SEEN_SET_MAX_SIZE = 10_000;
/** Max attribute-fingerprint resolutions retained per Exposure identity. */
export const DEFAULT_VALUES_PER_ENTRY = 64;
// Matches the ~60s KV propagation window the platform already tolerates.
export const DEFAULT_REVALIDATE_MS = 60_000;

/**
 * A cached resolution. For an Exposure-bearing evaluate miss, `variant: null`
 * records a wire 200 no-match so a CACHED replay can re-apply the CURRENT call's
 * Default Variant. For a context-miss verify result, `variant` is the served
 * value (including DEFAULT / DISABLED) so identical inputs replay identically.
 * `variantName` rides along because a CACHED replay reports the same arm the
 * live call did; re-deriving it is impossible client-side.
 */
export interface SeenResolution {
  readonly variant: VariantValue | null;
  readonly variantName: string | null;
}

interface SeenEntry extends SeenResolution {
  readonly runId: string;
  /** Epoch ms when this entry was written; the TTL is measured from here. */
  readonly storedAt: number;
}

/**
 * Lookup against the seen-set for one evaluate call.
 *
 * - `hit`: same Exposure identity AND same attributes → replay value, suppress Exposure.
 * - `context-miss`: Exposure identity still fresh, but attributes differ (or were
 *   never stored for this fingerprint) → re-resolve value WITHOUT a second Exposure.
 * - `miss`: never seen, or past the revalidation window → Exposure-bearing evaluate.
 */
export type SeenLookupResult =
  | { readonly kind: "hit"; readonly entry: SeenEntry }
  | { readonly kind: "context-miss"; readonly runId: string }
  | { readonly kind: "miss" };

interface StoredEntry {
  readonly runId: string;
  readonly storedAt: number;
  /** Attribute-fingerprint → wire resolution. Multiple contexts share one Exposure slot. */
  readonly values: Map<string, SeenResolution>;
}

function entryId(flagKey: string, idType: string, targetingKey: string): string {
  // Joined with NUL (escaped): the one byte the components will not contain,
  // so no two distinct (flagKey, idType, targetingKey) triples can collide.
  return `${flagKey}\u0000${idType}\u0000${targetingKey}`;
}

/**
 * Canonicalize a value so fingerprint equality does not depend on object-key
 * order. Arrays keep element order (arrays are ordered); plain objects sort
 * their keys recursively.
 */
function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = stableJsonValue(record[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Stable fingerprint of an Evaluation Context attribute map. Two maps that
 * differ only in property insertion order produce the same string; maps that
 * differ in any key or value do not.
 */
export function fingerprintAttributes(
  attributes: Readonly<Record<string, AttributeValue>>,
): string {
  return JSON.stringify(stableJsonValue(attributes));
}

export class SeenSet {
  // Keyed by Exposure identity (flagKey, idType, targetingKey). The entry
  // carries runId + storedAt (Exposure / TTL) and a per-attribute-fingerprint
  // value map (value replay).
  private readonly entries = new Map<string, StoredEntry>();

  constructor(
    private readonly maxSize: number = DEFAULT_SEEN_SET_MAX_SIZE,
    private readonly ttlMs: number = DEFAULT_REVALIDATE_MS,
    private readonly maxValuesPerEntry: number = DEFAULT_VALUES_PER_ENTRY,
  ) {
    if (maxSize < 1) {
      // Fail loud: a zero/negative cache is a misconfiguration, not a silent no-op.
      throw new SplitchSdkError({
        code: "SDK_SEEN_SET_MAX_SIZE_INVALID",
        causeSummary: `The seen-set maxSize must be at least 1 but received ${maxSize}`,
        remediation: "Set seenSetMaxSize to a positive integer",
      });
    }
    if (ttlMs < 0) {
      throw new SplitchSdkError({
        code: "SDK_SEEN_SET_TTL_INVALID",
        causeSummary: `The seen-set ttlMs must be at least 0 but received ${ttlMs}`,
        remediation: "Set revalidateMs to 0 or a positive duration in milliseconds",
      });
    }
    if (maxValuesPerEntry < 1) {
      throw new SplitchSdkError({
        code: "SDK_SEEN_SET_MAX_SIZE_INVALID",
        causeSummary: `The seen-set maxValuesPerEntry must be at least 1 but received ${maxValuesPerEntry}`,
        remediation: "Set maxValuesPerEntry to a positive integer",
      });
    }
  }

  /**
   * Look up this (flagKey, idType, targetingKey, attributes) against the
   * revalidation window. A value hit is an LRU touch. `now` is injected so the
   * TTL is testable without real time.
   */
  get(
    flagKey: string,
    idType: string,
    targetingKey: string,
    attributes: Readonly<Record<string, AttributeValue>>,
    now: number,
  ): SeenLookupResult {
    const id = entryId(flagKey, idType, targetingKey);
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return { kind: "miss" };
    }
    if (now - entry.storedAt >= this.ttlMs) {
      // Stale: force a revalidation so a Run boundary is detected within the TTL.
      this.entries.delete(id);
      return { kind: "miss" };
    }
    const fingerprint = fingerprintAttributes(attributes);
    const resolution = entry.values.get(fingerprint);
    if (resolution === undefined) {
      // Exposure still fresh for this Entity/Run; attributes differ → re-resolve
      // value without a second Exposure-bearing evaluate.
      return { kind: "context-miss", runId: entry.runId };
    }
    // Re-insert Exposure identity and fingerprint to the most-recently-used tail.
    entry.values.delete(fingerprint);
    entry.values.set(fingerprint, resolution);
    this.entries.delete(id);
    this.entries.set(id, entry);
    return {
      kind: "hit",
      entry: {
        runId: entry.runId,
        storedAt: entry.storedAt,
        variant: resolution.variant,
        variantName: resolution.variantName,
      },
    };
  }

  /**
   * Record a resolved Variant under its runId and attribute fingerprint. NEVER
   * call this for an ERROR result — caching a failure-fallback would mask a
   * later real resolution (ADR-0036). The caller in evaluate.ts only reaches
   * this on a successful resolution.
   *
   * When an Exposure entry for this identity is already fresh, the new
   * resolution is added under its fingerprint without resetting `storedAt`, so
   * the revalidation window (and Exposure suppression) stays anchored to the
   * first touch. The nested values map is LRU-capped independently.
   */
  set(
    flagKey: string,
    runId: string,
    idType: string,
    targetingKey: string,
    attributes: Readonly<Record<string, AttributeValue>>,
    resolution: SeenResolution,
    now: number,
  ): void {
    const id = entryId(flagKey, idType, targetingKey);
    const fingerprint = fingerprintAttributes(attributes);
    const existing = this.entries.get(id);
    if (existing !== undefined && now - existing.storedAt < this.ttlMs) {
      // Same Exposure slot still fresh: keep storedAt from first touch and add
      // (or replace) this attribute fingerprint's resolution. runId is the
      // identity already on the slot — context-miss reuses it; a fresh evaluate
      // after TTL miss creates a new entry below instead.
      this.putValue(existing.values, fingerprint, resolution);
      this.entries.delete(id);
      this.entries.set(id, {
        runId: existing.runId,
        storedAt: existing.storedAt,
        values: existing.values,
      });
    } else {
      const values = new Map<string, SeenResolution>();
      this.putValue(values, fingerprint, resolution);
      this.entries.delete(id);
      this.entries.set(id, {
        runId,
        storedAt: now,
        values,
      });
    }
    if (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }

  /** Insert/replace a fingerprint and evict the least-recently-used when over cap. */
  private putValue(
    values: Map<string, SeenResolution>,
    fingerprint: string,
    resolution: SeenResolution,
  ): void {
    values.delete(fingerprint);
    values.set(fingerprint, resolution);
    while (values.size > this.maxValuesPerEntry) {
      const oldest = values.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      values.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
