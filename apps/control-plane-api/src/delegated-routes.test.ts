import { type ApiRouteContract, routesDelegatedBy } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import {
  type AuthResolver,
  DELEGATED_IDENTITY_HEADER,
  type RateLimiter,
} from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { DelegationBindings } from "./delegated-routes";

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

    const response = await createApp(deps({ bindings: { "analysis-api": analysis } })).request(
      `${RESULTS_PATH}?runId=run_7`,
      { headers: { authorization: "Bearer stub" } },
    );

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

    const response = await createApp(
      deps({ bindings: { "analysis-api": analysis }, appId: "app_other" }),
    ).request(RESULTS_PATH, { headers: { authorization: "Bearer stub" } });

    expect(response.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  /**
   * Mounting is derived from the registry, so the Environment check has to hold
   * for every delegated route rather than for the one this file happened to name.
   * Driving the table off `routesDelegatedBy` means a route delegated later is
   * covered the moment it is registered, which is the only way this keeps pace
   * with a handler that grows its own door list.
   */
  const environmentScoped = routesDelegatedBy("control-plane-api").filter(
    (route) => route.path.includes(":appId") && route.path.includes(":environmentId"),
  );

  it("covers every Environment-scoped delegated route", () => {
    // A registry that stopped producing these would make the table below vacuous.
    expect(environmentScoped.map((route) => route.operationId)).toContain("flags_test_eval");
    expect(environmentScoped.length).toBeGreaterThan(1);
  });

  it.each(
    environmentScoped.map((route) => [route.operationId, route] as const),
  )("refuses %s before the hop when the path's Environment belongs to another App", async (_operationId, route) => {
    const forwarded: Request[] = [];
    const stub = binding(forwarded, Response.json({ stats: [] }));

    // The caller is a legitimate app_1 operator and passes app_1 in the path, so
    // every co-scope check the generic guard chain can make passes. Only reading
    // the Environment under app_1's scope catches that env_9 is app_2's.
    const response = await createApp(
      deps({ bindings: { "analysis-api": stub, "evaluation-api": stub } }),
    ).request(foreignEnvironmentPath(route), {
      method: route.method,
      headers: { authorization: "Bearer stub", "content-type": "application/json" },
      ...(route.method === "POST"
        ? { body: JSON.stringify(REQUEST_BODIES[route.operationId]) }
        : {}),
    });

    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("APP_NOT_FOUND");
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

/**
 * The path a route declares, aimed at an Environment that exists under a DIFFERENT
 * App. `:appId` stays the caller's own App so the generic co-scope guard passes
 * and the delegation handler's check is the only thing left standing.
 */
function foreignEnvironmentPath(route: ApiRouteContract): string {
  return route.path
    .replace(":appId", "app_1")
    .replace(":environmentId", "env_9")
    .replace(/:[A-Za-z]+/g, "x_1");
}

/**
 * Minimum bodies that satisfy each POST route's schema, so validation cannot be
 * what rejects the request. A route added without an entry here answers 400 and
 * fails the assertion below, which is the reminder to add one.
 */
const REQUEST_BODIES: Record<string, unknown> = {
  experiment_results_post: {},
  flags_test_eval: {
    evaluationContext: { targetingKey: "u_1", idType: "user", attributes: {} },
  },
};

function binding(forwarded: Request[], response: Response): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      forwarded.push(new Request(input as RequestInfo, init));
      return response;
    },
  } as unknown as Fetcher;
}

function deps(options: { bindings?: DelegationBindings; appId?: string }) {
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
    repo: stubRepo(),
    ...(options.bindings ? { delegationBindings: options.bindings } : {}),
  };
}

/**
 * `env_9` exists, but under app_2. The read is scoped by App exactly as D1 is
 * (ADR-0018), so an Environment id from another tenant simply is not found --
 * which is the whole check.
 */
const ENVIRONMENTS = new Set(["app_1/env_1", "app_2/env_9"]);

function stubRepo(): Repository {
  return {
    identity: {
      getEnvironment: async ({ appId }: { appId: string }, environmentId: string) =>
        ENVIRONMENTS.has(`${appId}/${environmentId}`) ? { id: environmentId } : null,
    },
  } as unknown as Repository;
}
