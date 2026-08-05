import {
  CONTROL_PANEL_DELEGATION_HEADER,
  verifyControlPanelDelegation,
} from "@splitch/control-plane-sdk/control-panel-identity";
import { describe, expect, it, vi } from "vitest";
import { createControlPanelExperimentsClient } from "./control-plane-experiments";

const NOW = 1_800_000_000;
const ACTOR = { actorId: "user_acme", sessionExpiresAt: NOW + 3_600 };
const DELEGATION_SECRET = "test-control-panel-delegation-secret-1234";

describe("Control Panel Experiments transport", () => {
  it("uses signed operation-scoped delegation without forwarding the session handle", async () => {
    let capturedRequest: Request | undefined;
    const client = createControlPanelExperimentsClient(
      {
        fetch: vi.fn(async (request: Request) => {
          capturedRequest = request;
          return Response.json({ items: [] });
        }),
      } as unknown as Fetcher,
      ACTOR,
      DELEGATION_SECRET,
      {
        nowSeconds: () => NOW,
        nonce: () => "nonce_experiments_123456",
      },
    );

    await expect(client.list({ appId: "app_acme", environmentId: "env_dev" })).resolves.toEqual({
      ok: true,
      status: 200,
      data: { items: [] },
    });

    const request = capturedRequest;
    expect(request).toBeInstanceOf(Request);
    expect(request?.headers.get("x-splitch-panel-session")).toBeNull();
    await expect(
      verifyControlPanelDelegation(
        request?.headers.get(CONTROL_PANEL_DELEGATION_HEADER) ?? null,
        request?.clone() as Request,
        { id: "experiments_list" },
        DELEGATION_SECRET,
        NOW,
      ),
    ).resolves.toMatchObject({ actorId: ACTOR.actorId, operation: { id: "experiments_list" } });
  });

  it("signs the exact Experiment detail operation and request body", async () => {
    let capturedRequest: Request | undefined;
    const client = createControlPanelExperimentsClient(
      {
        fetch: vi.fn(async (request: Request) => {
          capturedRequest = request;
          return Response.json({
            experiment: {
              id: "exp_1",
              name: "Checkout",
              description: "",
              owner: "",
              tags: [],
              status: "draft",
              flagId: "flag_1",
              targetingKey: "userId",
              targetingKeyType: "user",
              activationMetricId: null,
              conversionWindowMs: 0,
              confidenceLevel: 0.95,
              dimensions: [],
              metricIds: [],
              guardrailMetricIds: [],
              draftAllocation: null,
              draftSalt: null,
              draftTargetingRulesJson: null,
              draftSegmentIds: [],
              liveRunId: null,
            },
            flag: { id: "flag_1", name: "Checkout Flag" },
            metrics: [],
            variants: [],
            runs: [],
          });
        }),
      } as unknown as Fetcher,
      ACTOR,
      DELEGATION_SECRET,
      {
        nowSeconds: () => NOW,
        nonce: () => "nonce_experiment_detail_123456",
      },
    );

    await expect(
      client.detail({ appId: "app_acme", environmentId: "env_dev", experimentId: "exp_1" }),
    ).resolves.toMatchObject({ ok: true, data: { experiment: { id: "exp_1" } } });

    const request = capturedRequest;
    await expect(
      verifyControlPanelDelegation(
        request?.headers.get(CONTROL_PANEL_DELEGATION_HEADER) ?? null,
        request?.clone() as Request,
        { id: "experiments_detail" },
        DELEGATION_SECRET,
        NOW,
      ),
    ).resolves.toMatchObject({ actorId: ACTOR.actorId, operation: { id: "experiments_detail" } });
  });
});

describe("Control Panel Experiment mutation transport", () => {
  it("signs exact resource-scoped operations without forwarding a bearer", async () => {
    const requests: Request[] = [];
    const client = createControlPanelExperimentsClient(
      {
        fetch: vi.fn(async (request: Request) => {
          requests.push(request);
          return request.url.endsWith("/start")
            ? Response.json({
                experimentId: "exp_1",
                run: runResponse(),
                previousRunId: "run_1",
                // What the Worker returns when the Environment Policy allows the
                // Start outright, i.e. no Approval Request was ever created.
                approvalRequest: null,
                frozenTargetingRules: [],
              })
            : Response.json(experimentResponse());
        }),
      } as unknown as Fetcher,
      ACTOR,
      DELEGATION_SECRET,
      {
        nowSeconds: () => NOW,
        nonce: () => `nonce_experiment_mutation_${requests.length}`,
      },
    );

    await expect(
      client.update({
        appId: "app_acme",
        environmentId: "env_dev",
        experimentId: "exp_1",
        conversionWindowMs: 86_400_000,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      client.start({
        appId: "app_acme",
        environmentId: "env_dev",
        experimentId: "exp_1",
        idempotency_key: "idem_experiment_start",
        review: { action: "approve_and_apply" },
      }),
    ).resolves.toMatchObject({ ok: true });

    const operations = [
      {
        id: "experiments_update",
        appId: "app_acme",
        environmentId: "env_dev",
        experimentId: "exp_1",
      },
      {
        id: "experiments_start",
        appId: "app_acme",
        environmentId: "env_dev",
        experimentId: "exp_1",
      },
    ] as const;
    for (const [index, operation] of operations.entries()) {
      const request = requests[index];
      if (!request) throw new Error(`missing captured request ${index}`);
      expect(request.headers.get("authorization")).toBeNull();
      await expect(
        verifyControlPanelDelegation(
          request.headers.get(CONTROL_PANEL_DELEGATION_HEADER),
          request.clone() as unknown as Request,
          operation,
          DELEGATION_SECRET,
          NOW,
        ),
      ).resolves.toMatchObject({ actorId: ACTOR.actorId, operation });
    }
  });
});

function experimentResponse() {
  return {
    id: "exp_1",
    appId: "app_acme",
    environmentId: "env_dev",
    key: "checkout",
    flagId: "flag_1",
    name: "Checkout",
    status: "running",
    targetingKey: "userId",
    targetingKeyType: "user",
    confidenceLevel: 0.95,
    defaultVariantId: "variant_control",
    metrics: [],
    guardrailMetrics: [],
    conversionWindowMs: 86_400_000,
    dimensions: [],
    liveRunId: "run_1",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

function runResponse() {
  return {
    id: "run_2",
    experimentId: "exp_1",
    environmentId: "env_dev",
    status: "running",
    targetingKeyType: "user",
    activationMetricId: null,
    salt: "salt-2",
    allocation: { control: 60, treatment: 40 },
    variantSet: [
      { id: "variant_control", name: "control", value: false },
      { id: "variant_treatment", name: "treatment", value: true },
    ],
    targetingRules: [],
    configHash: "sha256:two",
    startedAt: "2026-07-19T00:00:00.000Z",
    endedAt: null,
    createdAt: "2026-07-19T00:00:00.000Z",
  };
}
