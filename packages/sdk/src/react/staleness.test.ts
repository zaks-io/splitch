// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSplitchBrowserClient, type SplitchBrowserClient } from "../browser/client";
import { getBrowserClientInternalAccess } from "../browser/client-internals";
import { FakeBrowserTransport } from "../browser/test-fixtures";
import type { PrecomputedEvaluations } from "../evaluate-all";
import type { EvaluateAllEntry, VariantValue } from "../generated/contract-surface.js";
import type { SdkResolutionDetails } from "../resolution";
import { FakeLogger } from "../test-fixtures";
import { SplitchProvider, useFlag, useFlagDetails } from "./index";

const CONTEXT = { targetingKey: "u1", idType: "user", attributes: {} } as const;
const FAILURE = {
  status: null,
  evaluations: null,
  etag: null,
  errorCode: "SDK_TRANSPORT_NETWORK" as const,
  errorMessage: "network down",
};

function entry(
  variant: VariantValue | null,
  reason: EvaluateAllEntry["reason"] = "SPLIT",
  errorCode: EvaluateAllEntry["errorCode"] = null,
): EvaluateAllEntry {
  return {
    variant,
    variantName: variant === null ? null : "on",
    reason,
    errorCode,
    exposureIdentity: null,
    exposureTicket: null,
  };
}

function bootstrap(evaluations: Record<string, EvaluateAllEntry>): PrecomputedEvaluations {
  return { context: CONTEXT, evaluations, etag: '"etag-1"' };
}

function createClient(
  evaluations: Record<string, EvaluateAllEntry>,
  revalidations: ConstructorParameters<typeof FakeBrowserTransport>[0],
) {
  return createSplitchBrowserClient({
    clientKey: "pk_test",
    context: { targetingKey: "u1" },
    bootstrap: bootstrap(evaluations),
    revalidateMs: 1_000,
    transport: new FakeBrowserTransport(revalidations),
    logger: new FakeLogger(),
    document: null,
    window: null,
  });
}

async function mount(client: SplitchBrowserClient, child: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SplitchProvider, { client }, child));
  });
  return { root, container };
}

async function unmount(root: Root, container: HTMLElement) {
  await act(async () => root.unmount());
  container.remove();
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("useFlagDetails staleness updates", () => {
  it("reads current degradation outside the held-resolution memo and preserves pair identity", async () => {
    const client = createClient({ checkout: entry(true) }, [
      FAILURE,
      { status: 304, evaluations: null, etag: null },
      { status: 200, evaluations: { checkout: entry(false) }, etag: '"etag-2"' },
    ]);
    const internal = getBrowserClientInternalAccess(client);
    const heldBeforeFailure = internal.readHeldEntry("checkout");
    const seen: SdkResolutionDetails[] = [];
    let bump = () => undefined;
    function Consumer() {
      const [, setCount] = useState(0);
      bump = () => setCount((value) => value + 1);
      seen.push(useFlagDetails("checkout", false));
      return null;
    }
    const mounted = await mount(client, createElement(Consumer));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ value: true, reason: "SPLIT" });

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(seen).toHaveLength(1);
    expect(internal.readHeldEntry("checkout")).toBe(heldBeforeFailure);
    await act(async () => bump());
    expect(seen[1]).toMatchObject({
      value: true,
      reason: "STALE",
      errorCode: "PROVIDER_NOT_READY",
    });
    expect(seen[1]).toEqual(client.evaluateDetails("checkout", false));
    await act(async () => bump());
    expect(seen[2]).toBe(seen[1]);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(seen).toHaveLength(3);
    await act(async () => bump());
    expect(seen[3]).toMatchObject({ value: true, reason: "SPLIT" });
    expect(seen[3]).not.toBe(seen[2]);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(seen[4]).toMatchObject({ value: false, reason: "SPLIT" });
    expect(seen[4]).not.toBe(seen[3]);

    await unmount(mounted.root, mounted.container);
    await client.close();
  });

  it("bypasses absent, held-ERROR, and null-variant details while degraded", async () => {
    const client = createClient(
      {
        broken: entry(false, "ERROR", "SERVICE_UNAVAILABLE"),
        empty: entry(null),
      },
      [FAILURE],
    );
    const seen: SdkResolutionDetails[][] = [];
    let bump = () => undefined;
    function Consumer() {
      const [, setCount] = useState(0);
      bump = () => setCount((value) => value + 1);
      seen.push([
        useFlagDetails("missing", "fallback"),
        useFlagDetails("broken", "fallback"),
        useFlagDetails("empty", "fallback"),
      ]);
      return null;
    }
    const mounted = await mount(client, createElement(Consumer));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await act(async () => bump());

    expect(seen[1]?.[0]).toBe(seen[0]?.[0]);
    expect(seen[1]?.[1]).toBe(seen[0]?.[1]);
    expect(seen[1]?.[2]).toBe(seen[0]?.[2]);
    expect(seen[1]).toMatchObject([
      { reason: "ERROR", errorCode: "FLAG_NOT_FOUND" },
      { reason: "ERROR", errorCode: "SERVICE_UNAVAILABLE" },
      { reason: "DEFAULT" },
    ]);

    await unmount(mounted.root, mounted.container);
    await client.close();
  });

  it("does not re-render useFlag when degradation enters", async () => {
    const client = createClient({ checkout: entry(true) }, [FAILURE]);
    const values: VariantValue[] = [];
    function Consumer() {
      values.push(useFlag("checkout", false));
      return null;
    }
    const mounted = await mount(client, createElement(Consumer));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(values).toEqual([true]);
    await unmount(mounted.root, mounted.container);
    await client.close();
  });
});

describe("useFlagDetails initial rendering", () => {
  it("preserves details identity for structurally equal object defaults", async () => {
    const client = createClient({ checkout: entry(true) }, []);
    const defaults: VariantValue[] = [];
    const seen: SdkResolutionDetails[] = [];
    let bump = () => undefined;
    function Consumer() {
      const [, setCount] = useState(0);
      bump = () => setCount((value) => value + 1);
      const defaultValue = { nested: { value: "fallback" } };
      defaults.push(defaultValue);
      seen.push(useFlagDetails("checkout", defaultValue));
      return null;
    }
    const mounted = await mount(client, createElement(Consumer));
    await act(async () => bump());
    await act(async () => bump());

    expect(defaults[1]).not.toBe(defaults[2]);
    expect(seen[1]).toBe(seen[2]);

    await unmount(mounted.root, mounted.container);
    await client.close();
  });

  it("leaves the first client-only render undecorated, then decorates an unrelated render", async () => {
    const client = createClient({ checkout: entry(true) }, [FAILURE]);
    await vi.advanceTimersByTimeAsync(1_000);
    const seen: SdkResolutionDetails[] = [];
    let bump = () => undefined;
    function Consumer() {
      const [, setCount] = useState(0);
      bump = () => setCount((value) => value + 1);
      seen.push(useFlagDetails("checkout", false));
      return null;
    }
    const mounted = await mount(client, createElement(Consumer));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.reason).toBe("SPLIT");
    await act(async () => bump());
    expect(seen[1]).toMatchObject({ reason: "STALE", errorCode: "PROVIDER_NOT_READY" });
    await unmount(mounted.root, mounted.container);
    await client.close();
  });

  it("keeps server and hydration renders undecorated until a later render", async () => {
    const client = createClient({ checkout: entry(true) }, [FAILURE]);
    await vi.advanceTimersByTimeAsync(1_000);
    const seen: SdkResolutionDetails[] = [];
    let bump = () => undefined;
    function Consumer() {
      const [, setCount] = useState(0);
      bump = () => setCount((value) => value + 1);
      seen.push(useFlagDetails("checkout", false));
      return null;
    }
    const tree = createElement(SplitchProvider, { client }, createElement(Consumer));
    const html = renderToString(tree);
    expect(seen[0]?.reason).toBe("SPLIT");

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    let root: Root | undefined;
    await act(async () => {
      root = hydrateRoot(container, tree);
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.reason).toBe("SPLIT");
    await act(async () => bump());
    expect(seen[2]).toMatchObject({ reason: "STALE", errorCode: "PROVIDER_NOT_READY" });

    if (root === undefined) {
      throw new Error("hydrateRoot did not return a root");
    }
    await unmount(root, container);
    await client.close();
  });
});
