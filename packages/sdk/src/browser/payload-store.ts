import type { EvaluateAllEntry } from "../generated/contract-surface.js";

export interface HeldPayload {
  readonly evaluations: Readonly<Record<string, EvaluateAllEntry>>;
  readonly etag: string;
}

type FlagListener = () => void;

export interface ListenerFailure {
  readonly flagKey: string;
  readonly cause: unknown;
}

/** Mutable identity for one atomically replaced Precomputed Evaluations payload. */
export class BrowserPayloadStore {
  private held: HeldPayload | null;
  private degraded = false;
  private readonly listeners = new Map<string, Set<FlagListener>>();

  constructor(initial: HeldPayload | null) {
    this.held = initial;
  }

  current(): HeldPayload | null {
    return this.held;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  setInitial(payload: HeldPayload): void {
    this.held = payload;
    this.degraded = false;
  }

  markDegraded(): void {
    this.degraded = true;
  }

  markRecovered(): void {
    this.degraded = false;
  }

  swap(payload: HeldPayload): readonly string[] {
    const previous = this.held;
    const changed =
      previous === null ? Object.keys(payload.evaluations) : diffFlags(previous, payload);
    this.held = payload;
    this.degraded = false;
    return changed;
  }

  notify(flagKeys: readonly string[]): readonly ListenerFailure[] {
    const failures: ListenerFailure[] = [];
    for (const flagKey of flagKeys) {
      for (const listener of this.listeners.get(flagKey) ?? []) {
        try {
          listener();
        } catch (cause) {
          failures.push({ flagKey, cause });
        }
      }
    }
    return failures;
  }

  subscribe(flagKey: string, listener: FlagListener): () => void {
    let flagListeners = this.listeners.get(flagKey);
    if (flagListeners === undefined) {
      flagListeners = new Set();
      this.listeners.set(flagKey, flagListeners);
    }
    flagListeners.add(listener);
    return () => {
      const current = this.listeners.get(flagKey);
      if (current !== flagListeners) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(flagKey);
      }
    };
  }
}

function diffFlags(previous: HeldPayload, next: HeldPayload): string[] {
  const flagKeys = new Set([
    ...Object.keys(previous.evaluations),
    ...Object.keys(next.evaluations),
  ]);
  return [...flagKeys].filter((flagKey) => {
    const before = previous.evaluations[flagKey];
    const after = next.evaluations[flagKey];
    const beforePresent = Object.hasOwn(previous.evaluations, flagKey);
    const afterPresent = Object.hasOwn(next.evaluations, flagKey);
    return beforePresent !== afterPresent || !entriesEqual(before, after);
  });
}

function entriesEqual(
  before: EvaluateAllEntry | undefined,
  after: EvaluateAllEntry | undefined,
): boolean {
  if (before === undefined || after === undefined) {
    return before === after;
  }
  return (
    canonicalEqual(before.variant, after.variant) &&
    before.variantName === after.variantName &&
    before.reason === after.reason &&
    before.errorCode === after.errorCode &&
    before.exposureIdentity === after.exposureIdentity
  );
}

/** Object key order is not part of JSON value identity; array order is. */
export function canonicalEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => canonicalEqual(value, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] &&
          Object.hasOwn(right, key) &&
          canonicalEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
