import { expect, it, vi } from "vitest";
import worker from "./index";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

it.each(["/", "/health"])(
  "keeps the Analysis smoke baseline on %s outside the router",
  async (path) => {
    const response = await worker.fetch(
      new Request(`https://analysis.test${path}`) as never,
      {
        SENTRY_DSN: "https://example@sentry.io/1",
      } as never,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "splitch-analysis-api",
      platformTarget: "local",
    });
  },
);
