// @vitest-environment happy-dom

import { act, createElement, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSplitchBrowserClient, type SplitchBrowserClient } from "../browser/client";
import { FakeBrowserTransport } from "../browser/test-fixtures";
import type { PrecomputedEvaluations } from "../evaluate-all";
import type { EvaluateAllEntry } from "../generated/contract-surface.js";
import { FakeLogger } from "../test-fixtures";
import { SplitchProvider, useFlag } from "./index";

const CONTEXT = { targetingKey: "u1", idType: "user", attributes: {} } as const;

const HELD_ERROR: EvaluateAllEntry = {
  variant: null,
  variantName: null,
  reason: "ERROR",
  errorCode: "SERVICE_UNAVAILABLE",
  exposureIdentity: null,
  exposureTicket: null,
};

const NULL_VARIANT: EvaluateAllEntry = {
  variant: null,
  variantName: null,
  reason: "SPLIT",
  errorCode: null,
  exposureIdentity: null,
  exposureTicket: null,
};

function bootstrap(evaluations: Record<string, EvaluateAllEntry>): PrecomputedEvaluations {
  return { context: CONTEXT, evaluations, etag: '"etag-1"' };
}

function clientWith(evaluations: Record<string, EvaluateAllEntry>) {
  const logger = new FakeLogger();
  const transport = new FakeBrowserTransport([]);
  const client = createSplitchBrowserClient({
    clientKey: "pk_test",
    context: { targetingKey: "u1" },
    bootstrap: bootstrap(evaluations),
    revalidateMs: 0,
    transport,
    logger,
    document: null,
    window: null,
  });
  return { client, logger, transport };
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

describe("React held-resolution logging", () => {
  it.each([
    {
      name: "missing",
      flagKey: "missing",
      evaluations: {},
      expectedCode: "FLAG_NOT_FOUND",
    },
    {
      name: "held ERROR",
      flagKey: "broken",
      evaluations: { broken: HELD_ERROR },
      expectedCode: "SERVICE_UNAVAILABLE",
    },
    {
      name: "null variant",
      flagKey: "empty",
      evaluations: { empty: NULL_VARIANT },
      expectedCode: "VALIDATION_ERROR",
    },
  ])("logs $name once across SSR, commit, and re-renders", async (row) => {
    const { client, logger, transport } = clientWith(row.evaluations);
    let bump = () => undefined;
    function Consumer() {
      const [, setCount] = useState(0);
      bump = () => setCount((value) => value + 1);
      return createElement("span", null, String(useFlag(row.flagKey, "fallback")));
    }
    const child = createElement(Consumer);

    expect(renderToString(createElement(SplitchProvider, { client }, child))).toBe(
      "<span>fallback</span>",
    );
    expect(logger.errors).toHaveLength(1);
    const mounted = await mount(client, child);
    await act(async () => bump());
    await act(async () => bump());
    await client.flush();

    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.message).toContain(row.expectedCode);
    expect(transport.redeemCalls).toHaveLength(0);

    await unmount(mounted.root, mounted.container);
    await client.close();
  });

  it("deduplicates a held ERROR across StrictMode and multiple readers", async () => {
    const { client, logger, transport } = clientWith({ broken: HELD_ERROR });
    function Reader() {
      useFlag("broken", false);
      return null;
    }
    const readers = createElement(
      StrictMode,
      null,
      createElement(Reader),
      createElement(Reader),
      createElement(Reader),
    );
    const mounted = await mount(client, readers);
    await client.flush();

    expect(logger.errors).toHaveLength(1);
    expect(transport.redeemCalls).toHaveLength(0);

    await unmount(mounted.root, mounted.container);
    await client.close();
  });
});
