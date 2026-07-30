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
              status: "draft",
              flagId: "flag_1",
              liveRunId: null,
            },
            flag: { id: "flag_1", name: "Checkout Flag" },
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
