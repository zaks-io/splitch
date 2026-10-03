import { type ApiRouteContract, routesDelegatedBy } from "@splitch/contracts";
import { DELEGATED_IDENTITY_HEADER } from "@splitch/worker-runtime";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { binding, deps, RESULTS_PATH } from "./delegated-routes-test-fixtures";
import { analysisEnvelope, statsOutput } from "./panel-experiments-test-fixtures";

/**
 * The gateway half of ADR-0046: `api.splitch.dev` answers for routes the Analysis
 * Worker executes. The delegation protocol itself is covered in worker-runtime;
 * what is wired here is that the guard chain runs BEFORE the hop and that a
 * missing binding is a loud refusal rather than a door that reads as absent.
 *
 * SPL-305 / plan 0.15 results enrichment lives in experiment-results-delegated.test.ts.
 */

describe("delegated control-plane routes", () => {
  it("forwards an authorized request to the owner with the authorized identity", async () => {
    const forwarded: Request[] = [];
    const analysis = binding(forwarded, Response.json(analysisEnvelope("run_7", statsOutput())));

    const response = await createApp(deps({ bindings: { "analysis-api": analysis } })).request(
      `${RESULTS_PATH}?runId=run_7`,
      { headers: { authorization: "Bearer stub" } },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      view: string;
      state: string;
      readiness: { statistical: boolean };
      stats: unknown;
    };
    expect(body).toMatchObject({
      view: "detailed",
      state: "ready",
      readiness: { statistical: expect.any(Boolean) },
      run_id: "run_7",
    });
    expect(body.stats).toEqual(statsOutput());
    expect(Object.keys(body).slice(0, 5)).toEqual([
      "view",
      "state",
      "readiness",
      "blockedBy",
      "reasons",
    ]);
    const sent = forwarded[0];
    expect(new URL(sent?.url ?? "").pathname).toBe(RESULTS_PATH);
    expect(new URL(sent?.url ?? "").searchParams.get("runId")).toBe("run_7");
    expect(new URL(sent?.url ?? "").searchParams.has("view")).toBe(false);
    expect(JSON.parse(sent?.headers.get(DELEGATED_IDENTITY_HEADER) ?? "{}")).toEqual({
      operation: "experiment_results_get",
      actorId: "user_1",
      authKind: "control-plane-token",
      scopes: [],
      orgId: null,
      appId: "app_1",
      environmentId: "env_1",
    });
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

  const environmentScoped = routesDelegatedBy("control-plane-api").filter(
    (route) =>
      route.operationId !== "environment_exposure_status_get" &&
      route.path.includes(":appId") &&
      route.path.includes(":environmentId"),
  );

  it("covers every Environment-scoped delegated route", () => {
    expect(environmentScoped.map((route) => route.operationId)).toContain("flags_test_eval");
    expect(environmentScoped.length).toBeGreaterThan(1);
  });

  it.each(environmentScoped.map((route) => [route.operationId, route] as const))(
    "refuses %s before the hop when the path's Environment belongs to another App",
    async (_operationId, route) => {
      const forwarded: Request[] = [];
      const stub = binding(forwarded, Response.json({ stats: [] }));

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
    },
  );

  it("fails loud without naming the owner, and logs the owner for operators", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await createApp(deps({})).request(RESULTS_PATH, {
      headers: { authorization: "Bearer stub" },
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("SERVICE_UNAVAILABLE");
    expect(body.message).toBe("experiment_results_get is temporarily unavailable");
    expect(body.message).not.toContain("analysis-api");
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("experiment_results_get is executed by analysis-api"),
    );
    errorLog.mockRestore();
  });
});

function foreignEnvironmentPath(route: ApiRouteContract): string {
  return route.path
    .replace(":appId", "app_1")
    .replace(":environmentId", "env_9")
    .replace(/:[A-Za-z]+/g, "x_1");
}

const REQUEST_BODIES: Record<string, unknown> = {
  experiment_results_post: {},
  flags_test_eval: {
    evaluationContext: { targetingKey: "u_1", idType: "user", attributes: {} },
  },
};
