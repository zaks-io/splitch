import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { EvaluationEntrypoint } from "./index";
import {
  appId,
  baseExposure,
  environmentId,
  fixedNow,
  makeEnv,
  mockTinybirdFetch,
  organizationId,
  TestExecutionContext,
  workerRequest,
} from "./test-fixtures";
import type { Env } from "./types";

const INTERNAL_PATHS = [
  "/api/internal/exposures",
  "/api/internal/evaluations",
  "/api/internal/evaluation-commits",
] as const;

const PUBLIC_ORIGIN = "https://ingest.splitch.dev";
const BINDING_ORIGIN = "https://splitch-event-ingest.internal";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("internal ingest authority", () => {
  it.each(
    INTERNAL_PATHS,
  )("returns not found on the public hostname for %s before reading tenant headers", async (path) => {
    const fetch = mockTinybirdFetch();
    const ctx = new TestExecutionContext();

    const response = await worker.fetch(
      workerRequest(`${PUBLIC_ORIGIN}${path}`, {
        method: "POST",
        headers: {
          authorization: "Bearer internal_ingest_secret",
          "content-type": "application/json",
          "x-splitch-app-id": "app_attacker",
          "x-splitch-environment-id": "env_attacker",
          "x-splitch-organization-id": "org_attacker",
        },
        body: "{",
      }),
      makeEnv(),
      ctx,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.waits).toHaveLength(0);
  });

  it("does not let public headers select another App or Environment write scope", async () => {
    const fetch = mockTinybirdFetch();
    const ctx = new TestExecutionContext();

    const response = await worker.fetch(
      workerRequest(`${PUBLIC_ORIGIN}/api/internal/exposures`, {
        method: "POST",
        headers: {
          authorization: "Bearer internal_ingest_secret",
          "content-type": "application/json",
          "x-splitch-app-id": "app_other",
          "x-splitch-environment-id": "env_other",
        },
        body: JSON.stringify(baseExposure()),
      }),
      makeEnv(),
      ctx,
    );

    expect(response.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a missing binding token before reading tenant headers", async () => {
    const { response, fetch, ctx } = await binding("/api/internal/exposures", {
      authorization: null,
      body: "{",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "UNAUTHORIZED",
      message: "invalid internal ingest token",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.waits).toHaveLength(0);
  });

  it("rejects a wrong binding token before reading tenant headers", async () => {
    const { response, fetch, ctx } = await binding("/api/internal/exposures", {
      authorization: "Bearer wrong",
      body: "{",
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({
      code: "UNAUTHORIZED",
      message: "invalid internal ingest token",
    });
    expect(JSON.stringify(body)).not.toContain("wrong");
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.waits).toHaveLength(0);
  });

  it("accepts the current scoped Exposure payload over the binding", async () => {
    const { response, fetch } = await binding("/api/internal/exposures", {
      body: JSON.stringify(baseExposure()),
    });

    expect(response.status).toBe(202);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps binding writes on the authenticated App and Environment headers", async () => {
    const { response, fetch } = await binding("/api/internal/exposures", {
      headers: {
        "x-splitch-app-id": appId,
        "x-splitch-environment-id": environmentId,
      },
      body: JSON.stringify({
        ...baseExposure(),
        appId: "app_from_client",
        environmentId: "env_from_client",
      }),
    });

    expect(response.status).toBe(202);
    const row = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(row.app_id).toBe(appId);
    expect(row.environment_id).toBe(environmentId);
    expect(row.app_id).not.toBe("app_from_client");
  });
});

async function binding(
  path: (typeof INTERNAL_PATHS)[number],
  options: {
    authorization?: string | null;
    headers?: Record<string, string>;
    body: string;
  },
) {
  vi.spyOn(Date, "now").mockReturnValue(new Date(fixedNow).getTime());
  const fetch = mockTinybirdFetch();
  const ctx = new TestExecutionContext();
  const headers = new Headers({
    "content-type": "application/json",
    "x-splitch-app-id": appId,
    "x-splitch-environment-id": environmentId,
    "x-splitch-organization-id": organizationId,
    ...options.headers,
  });
  if (options.authorization === undefined) {
    headers.set("authorization", "Bearer internal_ingest_secret");
  } else if (options.authorization !== null) {
    headers.set("authorization", options.authorization);
  }

  const response = await new EvaluationEntrypoint(ctx, makeEnv() as Env).fetch(
    new Request(`${BINDING_ORIGIN}${path}`, {
      method: "POST",
      headers,
      body: options.body,
    }),
  );
  return { response, fetch, ctx };
}
