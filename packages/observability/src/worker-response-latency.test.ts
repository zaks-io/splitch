import { afterEach, describe, expect, it, vi } from "vitest";
import { __setSentryModuleForTests } from "./sentry-module.js";
import { wrapWorkerHandler } from "./worker.js";

afterEach(() => __setSentryModuleForTests(undefined));

describe("Evaluation response latency", () => {
  it("classifies the native invocation without waiting for the live socket to close", async () => {
    const setAttribute = vi.fn();
    const pending: Promise<unknown>[] = [];
    let closeSocket = () => {};
    const socketLifetime = new Promise<void>((resolve) => {
      closeSocket = resolve;
    });
    const handler = wrapWorkerHandler(
      {
        async fetch(_request, _env, ctx) {
          ctx.waitUntil(socketLifetime);
          return Response.json({ value: true });
        },
      },
      { surface: "evaluation-api" },
    );
    __setSentryModuleForTests({
      withSentry: (_options: unknown, worker: unknown) => worker,
    } as never);
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      tracing: { getActiveSpan: () => ({ setAttribute }) },
    } as unknown as ExecutionContext;

    const response = await handler.fetch(
      new Request("https://edge.splitch.dev/api/sdk/verify") as never,
      { SENTRY_DSN: "https://public@example.invalid/1" },
      ctx,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ value: true });
    expect(setAttribute).toHaveBeenCalledWith("sentry.op", "function.cloudflare.invocation");
    expect(pending).toEqual([socketLifetime]);
    closeSocket();
    await Promise.all(pending);
  });

  it("leaves other Workers' native operation unchanged", async () => {
    const getActiveSpan = vi.fn();
    const handler = wrapWorkerHandler(
      { fetch: async () => Response.json({ ok: true }) },
      { surface: "control-plane-api" },
    );
    await handler.fetch(new Request("https://api.splitch.dev/health") as never, {}, {
      tracing: { getActiveSpan },
    } as unknown as ExecutionContext);
    expect(getActiveSpan).not.toHaveBeenCalled();
  });

  it("serves responses on older local runtimes without the native active-span API", async () => {
    const handler = wrapWorkerHandler(
      { fetch: async () => Response.json({ ok: true }) },
      { surface: "evaluation-api" },
    );
    const response = await handler.fetch(
      new Request("https://edge.splitch.dev/api/sdk/verify") as never,
      {},
      { tracing: {} } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(200);
  });
});
