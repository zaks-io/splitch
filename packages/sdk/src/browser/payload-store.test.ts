import { describe, expect, it, vi } from "vitest";
import type { EvaluateAllEntry, VariantValue } from "../generated/contract-surface.js";
import { BrowserPayloadStore, type HeldPayload } from "./payload-store";

function entry(variant: VariantValue, exposureTicket: string | null = null): EvaluateAllEntry {
  return {
    variant,
    variantName: "on",
    reason: "SPLIT",
    errorCode: null,
    exposureIdentity: exposureTicket === null ? null : "binding-1",
    exposureTicket,
  };
}

function payload(variant: boolean, etag: string): HeldPayload {
  return { evaluations: { checkout: entry(variant) }, etag };
}

describe("BrowserPayloadStore subscriptions", () => {
  it("stops notifications after unsubscribe", () => {
    const store = new BrowserPayloadStore(payload(true, '"etag-1"'));
    const listener = vi.fn();
    const unsubscribe = store.subscribe("checkout", listener);

    unsubscribe();
    store.notify(["checkout"]);

    expect(listener).not.toHaveBeenCalled();
  });

  it("makes unsubscribe idempotent", () => {
    const store = new BrowserPayloadStore(payload(true, '"etag-1"'));
    const unsubscribe = store.subscribe("checkout", vi.fn());

    unsubscribe();

    expect(() => unsubscribe()).not.toThrow();
  });

  it("does not let an old unsubscribe evict a replacement listener set", () => {
    const store = new BrowserPayloadStore(payload(true, '"etag-1"'));
    const oldUnsubscribe = store.subscribe("checkout", vi.fn());
    oldUnsubscribe();

    const replacement = vi.fn();
    store.subscribe("checkout", replacement);
    oldUnsubscribe();
    const changed = store.swap(payload(false, '"etag-2"'));
    store.notify(changed);

    expect(replacement).toHaveBeenCalledTimes(1);
  });
});

describe("BrowserPayloadStore swaps", () => {
  it("preserves an unchanged entry and Variant reference during a partial swap", () => {
    const stableVariant = { enabled: true };
    const stableEntry = entry(stableVariant);
    const changedEntry = entry(false);
    const store = new BrowserPayloadStore({
      evaluations: { stable: stableEntry, changed: changedEntry },
      etag: '"etag-1"',
    });
    const stableListener = vi.fn();
    store.subscribe("stable", stableListener);

    const changed = store.swap({
      evaluations: { stable: entry({ enabled: true }), changed: entry(true) },
      etag: '"etag-2"',
    });
    store.notify(changed);
    const current = store.current();

    expect(current?.evaluations.stable).toBe(stableEntry);
    expect(current?.evaluations.stable?.variant).toBe(stableVariant);
    expect(current?.evaluations.changed).not.toBe(changedEntry);
    expect(changed).toEqual(["changed"]);
    expect(stableListener).not.toHaveBeenCalled();
  });

  it("keeps fresh ticket bytes while preserving the Variant reference", () => {
    const previousVariant = { enabled: true };
    const previousEntry = entry(previousVariant, "ticket-old");
    const incomingEntry = entry({ enabled: true }, "ticket-fresh");
    const store = new BrowserPayloadStore({
      evaluations: { checkout: previousEntry },
      etag: '"etag-1"',
    });
    const listener = vi.fn();
    store.subscribe("checkout", listener);

    const changed = store.swap({
      evaluations: { checkout: incomingEntry },
      etag: '"etag-2"',
    });
    store.notify(changed);
    const currentEntry = store.current()?.evaluations.checkout;

    expect(currentEntry?.exposureTicket).toBe("ticket-fresh");
    expect(currentEntry).not.toBe(previousEntry);
    expect(currentEntry).not.toBe(incomingEntry);
    expect(currentEntry?.variant).toBe(previousVariant);
    expect(changed).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });
});
