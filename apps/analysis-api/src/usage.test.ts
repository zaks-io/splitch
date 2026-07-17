import { type ErrorResponse, OrganizationUsageResponseSchema } from "@splitch/contracts";
import type { AuthResolver, Principal, RateLimiter } from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { currentMonth, readUsageFromTinybird } from "./usage";
import { TinybirdReadError, type PipeParams, type TinybirdReadTransport } from "./tinybird";

const ORG_ID = "org_a";
const OTHER_ORG_ID = "org_b";
const USAGE_PATH = `/orgs/${ORG_ID}/usage`;
const NOW = new Date("2026-07-17T12:00:00.000Z");

class FakeTinybird implements TinybirdReadTransport {
  readonly calls: { pipeName: string; params: PipeParams }[] = [];

  constructor(private readonly rows: readonly unknown[] = usageRows()) {}

  async readPipe(pipeName: string, params: PipeParams): Promise<readonly unknown[]> {
    this.calls.push({ pipeName, params: { ...params } });
    return this.rows;
  }
}

class FailingTinybird implements TinybirdReadTransport {
  async readPipe(): Promise<readonly unknown[]> {
    throw new TinybirdReadError("forced outage");
  }
}

const allowLimiter: RateLimiter = () => ({ limited: false });

function principal(orgId: string | null): Principal {
  return {
    kind: "control-plane-token",
    id: "actor-1",
    scopes: orgId === null ? [] : [`org:${orgId}:member`],
    orgId,
    appId: null,
    environmentId: null,
  };
}

const authResolver: AuthResolver = (request) => {
  const authorization = request.headers.get("authorization");
  if (authorization === "Bearer org-a") {
    return { ok: true, principal: principal(ORG_ID) };
  }
  if (authorization === "Bearer org-b") {
    return { ok: true, principal: principal(OTHER_ORG_ID) };
  }
  return { ok: false, reason: "UNAUTHORIZED" };
};

function makeHarness(rows?: readonly unknown[]) {
  const tinybird = new FakeTinybird(rows);
  const app = createApp({
    authResolver,
    rateLimiter: allowLimiter,
    tinybird,
    now: () => NOW,
    platformTarget: "local",
  });
  return { app, tinybird };
}

describe("Organization Evaluation usage", () => {
  it("aggregates the current month across all five ADR-0033 reporting dimensions", async () => {
    const { app, tinybird } = makeHarness();

    const response = await app.request(USAGE_PATH, {
      headers: { authorization: "Bearer org-a" },
    });

    expect(response.status).toBe(200);
    const body = OrganizationUsageResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      organizationId: ORG_ID,
      period: {
        month: "2026-07",
        startsAt: "2026-07-01T00:00:00.000Z",
        endsAt: "2026-08-01T00:00:00.000Z",
      },
      state: "populated",
      evaluations: 5,
      breakdown: {
        byApp: [
          { appId: "app_1", evaluations: 5 },
          { appId: "app_2", evaluations: 0 },
        ],
        byEnvironment: [
          { environmentId: "env_dev", evaluations: 0 },
          { environmentId: "env_prod", evaluations: 5 },
        ],
        byBatch: [
          { mode: "batch", evaluations: 3 },
          { mode: "single", evaluations: 2 },
        ],
        bySource: [
          { source: "cached", evaluations: 0 },
          { source: "remote", evaluations: 5 },
        ],
        byExposure: [
          { exposure: "bearing", evaluations: 2 },
          { exposure: "not_bearing", evaluations: 3 },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain("targeting_key_hash");
    expect(tinybird.calls).toEqual([
      {
        pipeName: "analysis_evaluation_usage",
        params: {
          organization_id: ORG_ID,
          period_start: "2026-07-01T00:00:00.000Z",
          period_end: "2026-08-01T00:00:00.000Z",
        },
      },
    ]);
  });

  it("returns an explicit zero state for an empty current month", async () => {
    const { app } = makeHarness([]);

    const response = await app.request(USAGE_PATH, {
      headers: { authorization: "Bearer org-a" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      organizationId: ORG_ID,
      period: currentMonth(NOW),
      state: "zero",
      evaluations: 0,
      breakdown: {
        byApp: [],
        byEnvironment: [],
        byBatch: [],
        bySource: [],
        byExposure: [],
      },
    });
  });

  it("keeps cached dimensions visible without adding cached reads to consumed Evaluations", async () => {
    const { app } = makeHarness([usageRow("app_1", "env_prod", "single", "cached", "bearing", 0)]);

    const response = await app.request(USAGE_PATH, {
      headers: { authorization: "Bearer org-a" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "populated",
      evaluations: 0,
      breakdown: {
        bySource: [{ source: "cached", evaluations: 0 }],
        byExposure: [{ exposure: "bearing", evaluations: 0 }],
      },
    });
  });

  it("maps a Tinybird outage to a retryable usage read failure", async () => {
    const app = createApp({
      authResolver,
      rateLimiter: allowLimiter,
      tinybird: new FailingTinybird(),
      now: () => NOW,
      platformTarget: "local",
    });

    const response = await app.request(USAGE_PATH, {
      headers: { authorization: "Bearer org-a" },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      details: { retryAfterMs: 30_000 },
    });
  });
});

describe("Organization Evaluation usage isolation", () => {
  it("rejects an Org B token attempting to read Org A usage before Tinybird", async () => {
    const { app, tinybird } = makeHarness();

    const response = await app.request(USAGE_PATH, {
      headers: { authorization: "Bearer org-b" },
    });

    expect(response.status).toBe(403);
    expect(((await response.json()) as ErrorResponse).code).toBe("FORBIDDEN");
    expect(tinybird.calls).toEqual([]);
  });

  it("fails closed if the scoped Tinybird pipe returns another Organization's row", async () => {
    const tinybird = new FakeTinybird([{ ...usageRows()[0], organization_id: OTHER_ORG_ID }]);

    await expect(
      readUsageFromTinybird(tinybird, { organizationId: ORG_ID }, currentMonth(NOW)),
    ).rejects.toThrow("Organization scope");
  });
});

function usageRows(): readonly Record<string, unknown>[] {
  return [
    usageRow("app_1", "env_prod", "single", "remote", "bearing", 2),
    usageRow("app_1", "env_prod", "batch", "remote", "not_bearing", 3),
    usageRow("app_2", "env_dev", "batch", "cached", "bearing", 0),
    usageRow("app_2", "env_dev", "single", "cached", "not_bearing", 0),
  ];
}

function usageRow(
  appId: string,
  environmentId: string,
  mode: "single" | "batch",
  source: "remote" | "cached",
  exposure: "bearing" | "not_bearing",
  evaluations: number,
): Record<string, unknown> {
  return {
    organization_id: ORG_ID,
    app_id: appId,
    environment_id: environmentId,
    batch_mode: mode,
    evaluation_source: source,
    exposure_state: exposure,
    evaluations,
    targeting_key_hash: "hmac:must-not-leak",
  };
}
