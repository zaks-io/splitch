import type { Repository } from "@splitch/db";
import {
  type AuthResolver,
  DELEGATED_IDENTITY_HEADER,
  type RateLimiter,
} from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { DelegationBindings } from "./delegated-routes";

const STATUS_PATH = "/apps/app_1/envs/env_1/exposure-status";

describe("delegated Environment Exposure status", () => {
  it("rechecks live Organization and App membership before the Analysis hop", async () => {
    for (const missing of ["org", "app"] as const) {
      const forwarded: Request[] = [];
      const response = await createApp(deps(forwarded, missing)).request(STATUS_PATH, {
        headers: { authorization: "Bearer stub" },
      });

      expect(response.status).toBe(403);
      expect(forwarded).toEqual([]);
    }
  });

  it("delegates least-privilege App and Environment identity without the bearer", async () => {
    const forwarded: Request[] = [];
    const response = await createApp(deps(forwarded)).request(STATUS_PATH, {
      headers: { authorization: "Bearer stub" },
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(forwarded[0]?.headers.get(DELEGATED_IDENTITY_HEADER) ?? "{}")).toEqual({
      operation: "environment_exposure_status_get",
      actorId: "user_1",
      orgId: "org_1",
      appId: "app_1",
      environmentId: "env_1",
    });
    expect(forwarded[0]?.headers.get("authorization")).toBeNull();
  });
});

function deps(forwarded: Request[], missing?: "org" | "app") {
  const authResolver: AuthResolver = () => ({
    ok: true as const,
    principal: {
      kind: "control-plane-token" as const,
      id: "user_1",
      scopes: ["org:org_1:member", "app:app_1:member"],
      orgId: "org_1",
      appId: "app_1",
      environmentId: null,
      authDoor: "device_flow" as const,
    },
  });
  const rateLimiter: RateLimiter = () => ({ limited: false });
  const delegationBindings: DelegationBindings = {
    "analysis-api": {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        forwarded.push(new Request(input as RequestInfo, init));
        return Response.json({ state: "not_received", firstExposureAt: null });
      },
    } as unknown as Fetcher,
  };
  return { authResolver, rateLimiter, delegationBindings, repo: repo(missing) };
}

function repo(missing?: "org" | "app"): Repository {
  return {
    identity: {
      getApp: async (appId: string) =>
        appId === "app_1" ? { id: appId, organizationId: "org_1" } : null,
      getAppMembership: async () => (missing === "app" ? null : { role: "member" }),
      getOrgMembership: async () => (missing === "org" ? null : { role: "member" }),
      getEnvironment: async ({ appId }: { appId: string }, environmentId: string) =>
        appId === "app_1" && environmentId === "env_1" ? { id: environmentId } : null,
    },
  } as unknown as Repository;
}
