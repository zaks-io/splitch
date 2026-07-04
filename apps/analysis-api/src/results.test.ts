import { type ErrorResponse, StatsOutputSchema } from "@splitch/contracts";
import type { AuthResolver, Principal, RateLimiter } from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { makeResultsHandler, readStatsInputFromTinybird } from "./results";
import {
  APP_ID,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  FakeTinybird,
  OTHER_APP_ID,
  rowsByPipe,
  RUN_ID,
  type RowsByPipe,
} from "./results-test-support";

const PATH = `/apps/${APP_ID}/envs/${ENVIRONMENT_ID}/experiments/${EXPERIMENT_ID}/results`;
const REQUEST = new Request(`https://analysis.test${PATH}`);

const allowLimiter: RateLimiter = () => ({ limited: false });

function principal(appId: string | null, environmentId: string | null = null): Principal {
  return {
    kind: "control-plane-token",
    id: "actor-1",
    scopes: appId === null ? [] : [`app:${appId}:admin`],
    orgId: null,
    appId,
    environmentId,
  };
}

const authResolver: AuthResolver = (request) => {
  const authorization = request.headers.get("authorization");
  if (authorization === "Bearer cp-app") {
    return { ok: true, principal: principal(APP_ID) };
  }
  if (authorization === "Bearer cp-other-app") {
    return { ok: true, principal: principal(OTHER_APP_ID) };
  }
  if (authorization === "Bearer cp-no-app") {
    return { ok: true, principal: principal(null) };
  }
  if (authorization === "Bearer cp-other-env") {
    return { ok: true, principal: principal(APP_ID, "env_other") };
  }
  return { ok: false, reason: "UNAUTHORIZED" };
};

function makeHarness(rows?: RowsByPipe) {
  const tinybird = new FakeTinybird(rows);
  const app = createApp({
    authResolver,
    rateLimiter: allowLimiter,
    tinybird,
    platformTarget: "local",
  });
  return { app, tinybird };
}

function authInit(method: "GET" | "POST", body?: unknown): RequestInit {
  return {
    method,
    headers: {
      authorization: "Bearer cp-app",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

describe("Analysis Worker health", () => {
  it("keeps the smoke baseline on /", async () => {
    const { app } = makeHarness();

    const res = await app.request("/");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      service: "splitch-analysis-api",
      platformTarget: "local",
    });
  });
});

describe("GET/POST experiment results", () => {
  it("materializes Tinybird rows into StatsInput, calls StatsEngine, and returns StatsOutput", async () => {
    const { app, tinybird } = makeHarness();

    const res = await app.request(`${PATH}?runId=${RUN_ID}`, authInit("GET"));

    expect(res.status).toBe(200);
    const output = StatsOutputSchema.parse(await res.json());
    expect(output.health.deduped_counts).toEqual({ control: 2, treatment: 2 });
    expect(output.health.low_n_warning).toBe(true);
    expect(output.arm_results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric_id: "conversion",
          variant: "treatment",
          sample_size_n: 2,
        }),
      ]),
    );
    expect(tinybird.calls.map((call) => call.pipeName)).toEqual([
      "analysis_run_inputs",
      "analysis_deduped_exposures",
      "analysis_metric_values",
      "analysis_pre_period_covariates",
      "analysis_activation_rows",
    ]);
    expect(tinybird.calls.every((call) => call.params.app_id === APP_ID)).toBe(true);
    expect(tinybird.calls.every((call) => call.params.environment_id === ENVIRONMENT_ID)).toBe(
      true,
    );
    expect(tinybird.calls.slice(1).every((call) => call.params.run_id === RUN_ID)).toBe(true);
  });

  it("supports POST with runId in the body without accepting client app_id", async () => {
    const { app, tinybird } = makeHarness();

    const res = await app.request(PATH, authInit("POST", { runId: RUN_ID }));

    expect(res.status).toBe(200);
    StatsOutputSchema.parse(await res.json());
    expect(tinybird.calls[0]?.params).toMatchObject({
      app_id: APP_ID,
      environment_id: ENVIRONMENT_ID,
      experiment_id: EXPERIMENT_ID,
      run_id: RUN_ID,
    });
  });

  it("supports POST without a body for the live Run selector path", async () => {
    const { app, tinybird } = makeHarness();

    const res = await app.request(PATH, authInit("POST"));

    expect(res.status).toBe(200);
    StatsOutputSchema.parse(await res.json());
    expect(tinybird.calls[0]?.params).toMatchObject({
      app_id: APP_ID,
      environment_id: ENVIRONMENT_ID,
      experiment_id: EXPERIMENT_ID,
    });
  });
});

describe("GET/POST experiment results isolation", () => {
  it("returns RUN_NOT_FOUND when a requested Run has no Tinybird run-input rows", async () => {
    const { app, tinybird } = makeHarness({
      ...rowsByPipe(),
      analysis_run_inputs: [],
    });

    const res = await app.request(`${PATH}?runId=${RUN_ID}`, authInit("GET"));

    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponse).code).toBe("RUN_NOT_FOUND");
    expect(tinybird.calls.map((call) => call.pipeName)).toEqual(["analysis_run_inputs"]);
  });

  it("returns EXPERIMENT_NOT_FOUND when the live Run selector has no Tinybird run-input rows", async () => {
    const { app, tinybird } = makeHarness({
      ...rowsByPipe(),
      analysis_run_inputs: [],
    });

    const res = await app.request(PATH, authInit("GET"));

    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponse).code).toBe("EXPERIMENT_NOT_FOUND");
    expect(tinybird.calls.map((call) => call.pipeName)).toEqual(["analysis_run_inputs"]);
  });

  it("rejects missing and invalid control-plane tokens before any Tinybird read", async () => {
    const { app, tinybird } = makeHarness();

    const missing = await app.request(PATH);
    const invalid = await app.request(PATH, { headers: { authorization: "Bearer bad" } });

    expect(missing.status).toBe(401);
    expect(((await missing.json()) as ErrorResponse).code).toBe("UNAUTHORIZED");
    expect(invalid.status).toBe(401);
    expect(((await invalid.json()) as ErrorResponse).code).toBe("UNAUTHORIZED");
    expect(tinybird.calls).toEqual([]);
  });

  it("rejects cross-App path attempts before any Tinybird read", async () => {
    const { app, tinybird } = makeHarness();

    const res = await app.request(PATH, {
      headers: { authorization: "Bearer cp-other-app" },
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorResponse).code).toBe("FORBIDDEN");
    expect(tinybird.calls).toEqual([]);
  });

  it("rejects missing App context and Environment mismatches before any Tinybird read", async () => {
    const missingAppHarness = makeHarness();
    const missingApp = await missingAppHarness.app.request(PATH, {
      headers: { authorization: "Bearer cp-no-app" },
    });
    const environmentHarness = makeHarness();
    const environment = await environmentHarness.app.request(PATH, {
      headers: { authorization: "Bearer cp-other-env" },
    });

    expect(missingApp.status).toBe(403);
    expect(((await missingApp.json()) as ErrorResponse).code).toBe("FORBIDDEN");
    expect(missingAppHarness.tinybird.calls).toEqual([]);
    expect(environment.status).toBe(403);
    expect(((await environment.json()) as ErrorResponse).code).toBe("FORBIDDEN");
    expect(environmentHarness.tinybird.calls).toEqual([]);
  });

  it("maps handler-level scope mismatches to FORBIDDEN without Tinybird reads", async () => {
    const tinybird = new FakeTinybird();
    const handler = makeResultsHandler({ tinybird });

    const res = await handler({
      input: {
        params: {
          appId: OTHER_APP_ID,
          environmentId: ENVIRONMENT_ID,
          experimentId: EXPERIMENT_ID,
        },
      },
      principal: principal(APP_ID),
      requestId: "req_1",
      request: REQUEST,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorResponse).code).toBe("FORBIDDEN");
    expect(tinybird.calls).toEqual([]);
  });

  it("rejects client-supplied app_id in query or body before any Tinybird read", async () => {
    const queryHarness = makeHarness();
    const query = await queryHarness.app.request(`${PATH}?app_id=${OTHER_APP_ID}`, authInit("GET"));

    expect(query.status).toBe(400);
    expect(((await query.json()) as ErrorResponse).code).toBe("VALIDATION_ERROR");
    expect(queryHarness.tinybird.calls).toEqual([]);

    const bodyHarness = makeHarness();
    const body = await bodyHarness.app.request(
      PATH,
      authInit("POST", { runId: RUN_ID, app_id: OTHER_APP_ID }),
    );

    expect(body.status).toBe(400);
    expect(((await body.json()) as ErrorResponse).code).toBe("VALIDATION_ERROR");
    expect(bodyHarness.tinybird.calls).toEqual([]);
  });

  it("fails before any Tinybird read when app_id context is missing", async () => {
    const tinybird = new FakeTinybird();

    await expect(
      readStatsInputFromTinybird(tinybird, {
        appId: "",
        environmentId: ENVIRONMENT_ID,
        experimentId: EXPERIMENT_ID,
        runId: RUN_ID,
      }),
    ).rejects.toThrow(/app_id/);
    expect(tinybird.calls).toEqual([]);
  });
});
