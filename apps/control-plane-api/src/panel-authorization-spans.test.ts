import {
  CONTROL_PANEL_DELEGATION_HEADER,
  issueControlPanelDelegation,
} from "@splitch/control-plane-sdk/control-panel-identity";
import type {
  PerformanceSpanDescriptor,
  PerformanceSpanRecorder,
} from "@splitch/observability/performance-spans";
import { describe, expect, it, vi } from "vitest";
import { makeControlPlaneAuthResolver } from "./auth-resolver";

const NOW = 1_800_000_000;
const SECRET = "panel-authorization-span-test-secret";

async function harness() {
  const request = new Request("https://control.test/control-panel/experiments/results", {
    method: "POST",
    body: JSON.stringify({ appId: "private-app", environmentId: "private-env" }),
  });
  request.headers.set(
    CONTROL_PANEL_DELEGATION_HEADER,
    await issueControlPanelDelegation(
      request,
      { id: "experiments_results" },
      "private-actor",
      SECRET,
      { nowSeconds: NOW, sessionExpiresAt: NOW + 60 },
    ),
  );
  const recorded: PerformanceSpanDescriptor[] = [];
  const completed: string[] = [];
  const spans: PerformanceSpanRecorder = {
    async record(descriptor, run) {
      recorded.push(descriptor);
      try {
        return await run({ setAttribute() {}, setAttributes() {} });
      } finally {
        completed.push(descriptor.name);
      }
    },
  };
  const consume = vi.fn(async () => true);
  const resolver = makeControlPlaneAuthResolver(
    {
      verifier: { verify: vi.fn(async () => null) },
      sessions: { isRevoked: vi.fn(async () => false) },
      membershipAccess: {
        authorize: vi.fn(async () => false),
        resolve: vi.fn(async () => ({ organizations: [], apps: [] })),
      },
      now: () => NOW * 1_000,
    },
    {
      allowPanelDelegation: true,
      panelDelegationSecret: SECRET,
      panelDelegationReplay: { consume },
      spans,
    },
  );
  return { request, resolver, recorded, completed, consume };
}

describe("Panel authorization spans", () => {
  it("separates verification, replay redemption, and authority without recording identity", async () => {
    const h = await harness();
    expect(await h.resolver(h.request)).toMatchObject({
      ok: true,
      principal: { id: "private-actor" },
    });
    expect(h.recorded).toEqual([
      { name: "Panel delegation verification", op: "auth" },
      { name: "Panel delegation replay redemption", op: "rpc.client" },
      { name: "Panel delegation authority", op: "auth" },
    ]);
    expect(h.completed).toEqual(h.recorded.map((span) => span.name));
  });

  it("does not redeem an invalid delegation", async () => {
    const h = await harness();
    h.request.headers.set(CONTROL_PANEL_DELEGATION_HEADER, "invalid");
    expect(await h.resolver(h.request)).toEqual({ ok: false, reason: "UNAUTHORIZED" });
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.completed).toEqual(["Panel delegation verification"]);
  });

  it("preserves a replay-store fault and closes its span", async () => {
    const h = await harness();
    const fault = new Error("replay unavailable");
    h.consume.mockRejectedValueOnce(fault);
    await expect(h.resolver(h.request)).rejects.toBe(fault);
    expect(h.completed).toEqual([
      "Panel delegation verification",
      "Panel delegation replay redemption",
    ]);
  });
});
