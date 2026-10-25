import type { Repository } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import {
  detectMissingConvexDeployment,
  reprobeDormantConvexDeployments,
} from "./convex-deployments";
import { encryptConvexSecret } from "./convex-secret";
import { dispatchConvexWebhooks } from "./convex-webhook-dispatch";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const NOW = new Date("2026-10-25T08:00:00.000Z");
const CALLBACK = "https://example.convex.site/configuration";

async function dispatchFixture(status: number | Error, usher: boolean) {
  const encrypted = await encryptConvexSecret("secret", KEY, "v1");
  const finishDelivery = vi.fn(async () => "probe-token");
  const markDeploymentMissing = vi.fn();
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url) === CALLBACK) return new Response(null, { status: 404 });
    if (status instanceof Error) throw status;
    return new Response(null, { status, headers: usher ? { "convex-usher": "usher" } : {} });
  });
  const repo = {
    convex: {
      claimDueDeliveries: async () => [
        {
          deliveryId: "delivery",
          installationId: "installation",
          callbackUrl: CALLBACK,
          secretCiphertext: encrypted.ciphertext,
          secretKeyVersion: "v1",
          environmentVersion: 7,
          bodyJson: "{}",
          attemptCount: 0,
        },
      ],
      finishDelivery,
      markDeploymentMissing,
    },
  } as unknown as Repository;
  await dispatchConvexWebhooks({ repo, webhookKek: KEY, fetcher, now: () => NOW });
  return { finishDelivery, markDeploymentMissing, fetcher };
}

describe("dormant Convex deployments", () => {
  it.each([
    [404, true, true],
    [404, false, false],
    [200, true, false],
    [500, true, false],
  ])(
    "probes a terminal callback 404 and uses probe status %s with usher=%s",
    async (status, usher, missing) => {
      const fixture = await dispatchFixture(status as number, usher as boolean);
      expect(fixture.finishDelivery).toHaveBeenCalledWith(
        "delivery",
        expect.any(String),
        expect.objectContaining({ state: "terminal" }),
      );
      expect(fixture.fetcher).toHaveBeenCalledTimes(2);
      expect(fixture.markDeploymentMissing).toHaveBeenCalledTimes(missing ? 1 : 0);
      if (missing)
        expect(fixture.markDeploymentMissing).toHaveBeenCalledWith(
          "installation",
          "probe-token",
          NOW.toISOString(),
        );
    },
  );

  it("does not fail dispatch or mark dormancy on a probe timeout", async () => {
    const fixture = await dispatchFixture(new DOMException("timeout", "TimeoutError"), false);
    expect(fixture.markDeploymentMissing).not.toHaveBeenCalled();
    expect(fixture.finishDelivery).toHaveBeenCalledOnce();
  });

  it("isolates a failed dormancy write from dispatch completion", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const repo = {
      convex: {
        markDeploymentMissing: async () => {
          throw new Error("D1 private error");
        },
      },
    } as unknown as Repository;
    try {
      await expect(
        detectMissingConvexDeployment(
          {
            repo,
            fetcher: async () =>
              new Response(null, {
                status: 404,
                headers: { "convex-usher": "usher" },
              }),
          },
          {
            installationId: "installation",
            callbackUrl: CALLBACK,
            probeToken: "token",
            failedAt: NOW,
          },
        ),
      ).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        "convex_deployment_dormancy_failed",
        expect.objectContaining({ installationId: "installation" }),
      );
      expect(JSON.stringify(error.mock.calls)).not.toContain("D1 private error");
    } finally {
      error.mockRestore();
    }
  });

  it("checks a bounded dormant batch and reactivates only live deployments", async () => {
    const dormantDeployments = vi.fn(async () =>
      ["live", "deleted", "unknown"].map((id) => ({
        installationId: id,
        appId: "app",
        environmentId: "env",
        callbackUrl: `https://${id}.convex.site/configuration`,
      })),
    );
    const recordDeploymentCheck = vi.fn();
    const reactivateDeployment = vi.fn();
    const repo = {
      convex: { dormantDeployments, recordDeploymentCheck, reactivateDeployment },
    } as unknown as Repository;
    await reprobeDormantConvexDeployments({
      repo,
      now: NOW,
      fetcher: async (url) => {
        if (String(url).includes("live.convex")) return new Response("1.0", { status: 200 });
        if (String(url).includes("deleted.convex"))
          return new Response(null, { status: 404, headers: { "convex-usher": "usher" } });
        throw new Error("offline");
      },
    });
    expect(dormantDeployments).toHaveBeenCalledWith(100);
    expect(recordDeploymentCheck).toHaveBeenCalledTimes(3);
    expect(reactivateDeployment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ appId: "app", environmentId: "env" }),
      "live",
      NOW.toISOString(),
    );
  });
});
