import { describe, expect, it, vi } from "vitest";
import type { EvaluateAllEntry } from "../generated/contract-surface.js";
import { BrowserPayloadStore, type HeldPayload } from "./payload-store";

function payload(variant: boolean, etag: string): HeldPayload {
  const entry: EvaluateAllEntry = {
    variant,
    variantName: variant ? "on" : "off",
    reason: "SPLIT",
    errorCode: null,
    exposureIdentity: null,
    exposureTicket: null,
  };
  return { evaluations: { checkout: entry }, etag };
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
