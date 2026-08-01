import type { Repository } from "@splitch/db";
import {
  type AuthResolver,
  DELEGATED_IDENTITY_HEADER,
  type RateLimiter,
} from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

/**
 * The gateway half of ADR-0046: `api.splitch.dev` answers for routes the Analysis
 * Worker executes. The delegation protocol itself is covered in worker-runtime;
 * what is wired here is that the guard chain runs BEFORE the hop and that a
 * missing binding is a loud refusal rather than a door that reads as absent.
 */
const RESULTS_PATH = "/apps/app_1/envs/env_1/experiments/exp_1/results";

describe("delegated control-plane routes", () => {
  it("forwards an authorized request to the owner with the authorized identity", async () => {
    const forwarded: Request[] = [];
    const analysis = binding(forwarded, Response.json({ stats: [] }));

    const response = await createApp(deps({ analysis })).request(`${RESULTS_PATH}?runId=run_7`, {
      headers: { authorization: "Bearer stub" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stats: [] });
    const sent = forwarded[0];
    expect(new URL(sent?.url ?? "").pathname).toBe(RESULTS_PATH);
    expect(new URL(sent?.url ?? "").searchParams.get("runId")).toBe("run_7");
    expect(JSON.parse(sent?.headers.get(DELEGATED_IDENTITY_HEADER) ?? "{}")).toEqual({
      operation: "experiment_results_get",
      actorId: "user_1",
      orgId: null,
      appId: "app_1",
      environmentId: "env_1",
    });
    // The credential stops at the surface Worker; the binding is the authenticity
    // guarantee downstream.
    expect(sent?.headers.get("authorization")).toBeNull();
  });

  it("refuses before the hop when the caller is not bound to the path's App", async () => {
    const forwarded: Request[] = [];
    const analysis = binding(forwarded, Response.json({ stats: [] }));

    const response = await createApp(deps({ analysis, appId: "app_other" })).request(RESULTS_PATH, {
      headers: { authorization: "Bearer stub" },
    });

    expect(response.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it("fails loud naming the owner when its binding is missing", async () => {
    const response = await createApp(deps({})).request(RESULTS_PATH, {
      headers: { authorization: "Bearer stub" },
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("SERVICE_UNAVAILABLE");
    expect(body.message).toContain("analysis-api");
  });
});

function binding(forwarded: Request[], response: Response): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      forwarded.push(new Request(input as RequestInfo, init));
      return response;
    },
  } as unknown as Fetcher;
}

function deps(options: { analysis?: Fetcher; appId?: string }) {
  const authResolver: AuthResolver = () => ({
    ok: true as const,
    principal: {
      kind: "control-plane-token" as const,
      id: "user_1",
      scopes: [],
      orgId: null,
      appId: options.appId ?? "app_1",
      environmentId: null,
      authDoor: "device_flow" as const,
    },
  });
  const rateLimiter: RateLimiter = () => ({ limited: false });
  return {
    authResolver,
    rateLimiter,
    repo: {} as Repository,
    ...(options.analysis ? { delegationBindings: { "analysis-api": options.analysis } } : {}),
  };
}
