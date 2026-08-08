import { describe, expect, it } from "vitest";
import type { FlagChangeListener } from "./subscribe";
import { registerFlagListener } from "./subscribe";

describe("registerFlagListener", () => {
  it("stale unsubscribe does not evict a live listener set", () => {
    const listeners = new Map<string, Set<FlagChangeListener>>();
    const calls: string[] = [];
    const stop1 = registerFlagListener(listeners, "flag", () => {
      calls.push("1");
    });
    stop1();
    const stop2 = registerFlagListener(listeners, "flag", () => {
      calls.push("2");
    });
    // React StrictMode double-invokes the first cleanup after a remount.
    stop1();
    expect(listeners.get("flag")?.size).toBe(1);

    const stop3 = registerFlagListener(listeners, "flag", () => {
      calls.push("3");
    });
    stop2();
    expect(listeners.get("flag")?.size).toBe(1);

    for (const listener of listeners.get("flag") ?? []) {
      listener({ value: true, variantName: null, reason: "DEFAULT" });
    }
    expect(calls).toEqual(["3"]);
    stop3();
    expect(listeners.has("flag")).toBe(false);
  });
});
