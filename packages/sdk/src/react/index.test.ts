// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrecomputedEvaluations } from "../evaluate-all";
import type { EvaluateAllEntry } from "../generated/contract-surface.js";
import { FakeLogger } from "../test-fixtures";
import { createSplitchBrowserClient, type SplitchBrowserClient } from "../browser/client";
import { FakeBrowserTransport } from "../browser/test-fixtures";
import { sdkClientErrorCodes } from "../errors";
import { SplitchProvider, useFlag, useFlagDetails, useSplitchClient } from "./index";

const CONTEXT = { targetingKey: "u1", idType: "user", attributes: {} } as const;

function entry(variant: boolean, ticket: string | null = null): EvaluateAllEntry {
  return {
    variant,
    variantName: variant ? "on" : "off",
    reason: "SPLIT",
    errorCode: null,
    exposureIdentity: ticket === null ? null : `identity-${ticket}`,
    exposureTicket: ticket,
  };
}

function bootstrap(evaluations: Record<string, EvaluateAllEntry>): PrecomputedEvaluations {
  return { context: CONTEXT, evaluations, etag: '"etag-1"' };
}

function clientWith(
  evaluations: Record<string, EvaluateAllEntry>,
  revalidations: ConstructorParameters<typeof FakeBrowserTransport>[0] = [],
) {
  const transport = new FakeBrowserTransport(revalidations);
  const client = createSplitchBrowserClient({
    clientKey: "pk_test",
    context: { targetingKey: "u1" },
    bootstrap: bootstrap(evaluations),
    revalidateMs: revalidations.length === 0 ? 0 : 1_000,
    transport,
    document: null,
    window: null,
  });
  return { client, transport };
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

describe("React Flag subscriptions", () => {
  it("re-renders only subscribers of the Flag whose held entry changed", async () => {
    const { client } = clientWith({ checkout: entry(true), banner: entry(false) }, [
      {
        status: 200,
        evaluations: { checkout: entry(false), banner: entry(false) },
        etag: '"etag-2"',
      },
    ]);
    const renders = { checkout: 0, banner: 0 };
    function Subscriber({ flagKey }: { flagKey: "checkout" | "banner" }) {
      useFlag(flagKey, false);
      renders[flagKey] += 1;
      return null;
    }
    const tree = createElement(
      "div",
      null,
      createElement(Subscriber, { flagKey: "checkout" }),
      createElement(Subscriber, { flagKey: "banner" }),
    );
    const mounted = await mount(client, tree);

    expect(renders).toEqual({ checkout: 1, banner: 1 });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(renders).toEqual({ checkout: 2, banner: 1 });

    await unmount(mounted.root, mounted.container);
    await client.close();
  });

  it("subscribes by the exact Flag Key and adds no staleness channel", async () => {
    const failure = {
      status: null,
      evaluations: null,
      etag: null,
      errorCode: "SDK_TRANSPORT_NETWORK" as const,
      errorMessage: "network down",
    };
    const { client } = clientWith({ checkout: entry(true) }, [failure]);
    const subscribe = vi.spyOn(client, "subscribe");
    let renders = 0;
    function Consumer() {
      useFlagDetails("checkout", false);
      renders += 1;
      return null;
    }
    const mounted = await mount(client, createElement(Consumer));
    expect(subscribe.mock.calls.map(([flagKey]) => flagKey)).toEqual(["checkout"]);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(renders).toBe(1);
    expect(subscribe).toHaveBeenCalledTimes(1);

    await unmount(mounted.root, mounted.container);
    await client.close();
  });
});

describe("React exposing reads", () => {
  it("enqueues one first-read Exposure after commit across unrelated re-renders", async () => {
    const { client, transport } = clientWith({ checkout: entry(true, "ticket-1") });
    let bump = () => undefined;
    function Consumer() {
      const [, setCount] = useState(0);
      bump = () => setCount((value) => value + 1);
      useFlag("checkout", false);
      return null;
    }
    const mounted = await mount(client, createElement(Consumer));
    await act(async () => {
      bump();
      bump();
    });
    await client.flush();

    expect(transport.redeemCalls).toHaveLength(1);
    expect(transport.redeemCalls[0]?.exposures).toHaveLength(1);
    expect(transport.redeemCalls[0]?.exposures[0]?.exposureTicket).toBe("ticket-1");

    await unmount(mounted.root, mounted.container);
    await client.close();
  });

  it("fires no Exposure during server render", async () => {
    const { client, transport } = clientWith({ checkout: entry(true, "ticket-1") });
    function Consumer() {
      useFlag("checkout", false);
      return null;
    }
    renderToString(createElement(SplitchProvider, { client }, createElement(Consumer)));
    await client.flush();
    expect(transport.redeemCalls).toHaveLength(0);
    await client.close();
  });
});

describe("React fail-loud behavior", () => {
  it("throws SDK_REACT_PROVIDER_MISSING outside SplitchProvider", () => {
    function Consumer() {
      useFlag("checkout", false);
      return null;
    }
    expect(() => renderToString(createElement(Consumer))).toThrowError(
      expect.objectContaining({
        code: "SDK_REACT_PROVIDER_MISSING",
        message: expect.stringContaining("SplitchProvider"),
      }),
    );
  });

  it("throws the browser client's SDK_NOT_INITIALIZED before init resolves", () => {
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      revalidateMs: 0,
      transport: new FakeBrowserTransport([]),
      document: null,
      window: null,
    });
    function Consumer() {
      useFlag("checkout", false);
      return null;
    }
    expect(() =>
      renderToString(createElement(SplitchProvider, { client }, createElement(Consumer))),
    ).toThrowError(expect.objectContaining({ code: "SDK_NOT_INITIALIZED" }));
  });

  it("surfaces the caller default and client FLAG_NOT_FOUND details for an unknown key", async () => {
    const logger = new FakeLogger();
    const transport = new FakeBrowserTransport([]);
    const client = createSplitchBrowserClient({
      clientKey: "pk_test",
      context: { targetingKey: "u1" },
      bootstrap: bootstrap({ checkout: entry(true) }),
      revalidateMs: 0,
      transport,
      logger,
      document: null,
      window: null,
    });
    const seen: unknown[] = [];
    function Consumer() {
      seen.push(useFlag("missing", "caller-default"));
      seen.push(useFlagDetails("missing", "caller-default"));
      return null;
    }
    const mounted = await mount(client, createElement(Consumer));

    expect(seen[0]).toBe("caller-default");
    expect(seen[1]).toMatchObject({
      value: "caller-default",
      variantName: null,
      reason: "ERROR",
      errorCode: "FLAG_NOT_FOUND",
    });
    expect(logger.errors).toHaveLength(1);

    await unmount(mounted.root, mounted.container);
    await client.close();
  });

  it("returns the borrowed client and never closes it on unmount", async () => {
    const { client } = clientWith({ checkout: entry(true) });
    const close = vi.spyOn(client, "close");
    let received: SplitchBrowserClient | undefined;
    function Consumer() {
      received = useSplitchClient();
      return null;
    }
    const mounted = await mount(client, createElement(Consumer));
    expect(received).toBe(client);
    await unmount(mounted.root, mounted.container);
    expect(close).not.toHaveBeenCalled();
  });

  it("keeps PROVIDER_NOT_READY out of thrown SDK client codes", () => {
    const details = {
      value: true,
      variantName: "on",
      reason: "STALE",
      errorCode: "PROVIDER_NOT_READY",
    } as const satisfies ReturnType<typeof useFlagDetails>;
    expect(details.errorCode).toBe("PROVIDER_NOT_READY");
    expect(sdkClientErrorCodes).not.toContain("PROVIDER_NOT_READY");
  });
});
