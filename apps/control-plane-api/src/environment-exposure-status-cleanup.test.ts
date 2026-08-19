import { DELEGATED_IDENTITY_HEADER } from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { createEnvironmentExposureStatusCleanup } from "./environment-exposure-status-cleanup";

describe("Control Plane Environment Exposure status cleanup", () => {
  it("delegates exact App/Environment scope without a bearer", async () => {
    const requests: Request[] = [];
    const cleanup = createEnvironmentExposureStatusCleanup({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input as RequestInfo, init));
        return Response.json({ deleted: true });
      },
    } as unknown as Fetcher);

    await cleanup.delete({
      appId: "app_1",
      environmentId: "env_prod",
      actorId: "user_1",
      orgId: "org_1",
      requestId: "req_1",
    });

    const request = requests[0];
    expect(request?.method).toBe("DELETE");
    expect(new URL(request?.url ?? "").pathname).toBe("/internal/apps/app_1/exposure-status");
    expect(new URL(request?.url ?? "").searchParams.get("environmentId")).toBe("env_prod");
    expect(JSON.parse(request?.headers.get(DELEGATED_IDENTITY_HEADER) ?? "{}")).toEqual({
      operation: "environment_exposure_status_delete",
      actorId: "user_1",
      orgId: "org_1",
      appId: "app_1",
      environmentId: "env_prod",
    });
    expect(request?.headers.get("authorization")).toBeNull();
  });

  it("fails loud when the binding is absent or Analysis rejects cleanup", async () => {
    await expect(
      createEnvironmentExposureStatusCleanup(undefined).delete({
        appId: "app_1",
        actorId: "user_1",
        orgId: "org_1",
        requestId: "req_1",
      }),
    ).rejects.toThrow("ANALYSIS_API is required");

    const cleanup = createEnvironmentExposureStatusCleanup({
      fetch: async () => Response.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503 }),
    } as unknown as Fetcher);
    await expect(
      cleanup.delete({
        appId: "app_1",
        actorId: "user_1",
        orgId: "org_1",
        requestId: "req_1",
      }),
    ).rejects.toThrow("HTTP 503");
  });

  it.each([
    ["an empty object", {}],
    ["deleted false", { deleted: false }],
    ["an extra response field", { deleted: true, extra: 1 }],
  ])("rejects a 200 acknowledgement containing %s", async (_case, body) => {
    const cleanup = createEnvironmentExposureStatusCleanup({
      fetch: async () => Response.json(body),
    } as unknown as Fetcher);

    await expect(
      cleanup.delete({
        appId: "app_acknowledgement",
        environmentId: "env_acknowledgement",
        actorId: "user_acknowledgement",
        orgId: "org_acknowledgement",
        requestId: "req_acknowledgement",
      }),
    ).rejects.toThrow("Exposure status cleanup returned an invalid response");
  });
});
