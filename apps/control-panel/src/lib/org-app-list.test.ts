import { describe, expect, it } from "vitest";
import {
  type AppAttention,
  appAttentionSeverity,
  appAttentionSummary,
  attentionLabel,
  canCreateApp,
  environmentAttention,
  type OrgAppListApp,
} from "./org-app-list";

const environments = [
  { environmentId: "env_dev", env: "dev", name: "Development", guarded: false },
  { environmentId: "env_prod", env: "prod", name: "Production", guarded: true },
];

function app(attention: AppAttention): OrgAppListApp {
  return {
    appId: "app_checkout",
    appSlug: "checkout-api",
    environments,
    attention,
    flags: { kind: "ready", count: 4, truncated: false },
  };
}

const ready: AppAttention = {
  kind: "ready",
  items: [
    { environmentId: "env_dev", state: "clear", srm: false, guardrail: false },
    { environmentId: "env_prod", state: "attention", srm: true, guardrail: false },
  ],
};

describe("Org App list attention", () => {
  it("resolves each Environment's state independently", () => {
    expect(environmentAttention(ready, "env_dev")).toEqual({ kind: "clear" });
    expect(environmentAttention(ready, "env_prod")).toEqual({
      kind: "attention",
      srm: true,
      guardrail: false,
    });
  });

  it("reports an Environment missing from the rollup as unknown, never clear", () => {
    // A silently-calm card is indistinguishable from a healthy one, which is the
    // disguised default ADR-0036 forbids.
    expect(environmentAttention(ready, "env_staging")).toEqual({
      kind: "unknown",
      message: "The Control Plane returned no health for this Environment",
    });
  });

  it("carries the failure reason onto every Environment when the rollup could not be read", () => {
    const failed: AppAttention = { kind: "unavailable", message: "the binding is not configured" };

    expect(environmentAttention(failed, "env_dev")).toEqual({
      kind: "unknown",
      message: "the binding is not configured",
    });
    expect(appAttentionSummary(app(failed))).toBe("Experiment health unavailable");
  });

  it("names the Environment and the evidence in the screen-reader label", () => {
    expect(attentionLabel(environmentAttention(ready, "env_prod"), "Production")).toBe(
      "Production needs attention: Sample Ratio Mismatch firing.",
    );
    expect(attentionLabel({ kind: "attention", srm: true, guardrail: true }, "Production")).toBe(
      "Production needs attention: Sample Ratio Mismatch firing and Guardrail breached.",
    );
    expect(attentionLabel(environmentAttention(ready, "env_dev"), "Development")).toBeNull();
  });

  it("summarises which Environments need attention, by env handle", () => {
    expect(appAttentionSummary(app(ready))).toBe("Needs attention in prod");
    expect(
      appAttentionSummary(
        app({
          kind: "ready",
          items: [
            { environmentId: "env_dev", state: "no_data", srm: false, guardrail: false },
            { environmentId: "env_prod", state: "clear", srm: false, guardrail: false },
          ],
        }),
      ),
    ).toBe("No Experiment needs attention");
  });

  it("reports unknown, never healthy, when an Environment is missing from an otherwise-ok rollup", () => {
    // SPL-202: the exact SPL-103 review scenario — the rollup succeeds for
    // env_dev only, but the App also has env_prod. The per-Environment dot
    // was already correct (`environmentAttention` returns `unknown`); only
    // the App-level summary lied and called this a clean bill of health.
    const partialRollup: AppAttention = {
      kind: "ready",
      items: [{ environmentId: "env_dev", state: "clear", srm: false, guardrail: false }],
    };

    expect(appAttentionSeverity(app(partialRollup))).toBe("unknown");
    const summary = appAttentionSummary(app(partialRollup));
    expect(summary).toBe("Health unknown in prod");
    expect(summary).not.toBe("No Experiment needs attention");
    expect(summary.toLowerCase()).not.toContain("no experiment needs attention");
  });

  it("never lets an unknown Environment mask a confirmed problem in the same App", () => {
    // Ranking decision: `attention` outranks `unknown`. If dev is unknown and
    // prod is confirmed unhealthy, the operator must be told about prod —
    // "we don't know about dev" is not license to bury "prod is broken".
    const mixed: AppAttention = {
      kind: "ready",
      items: [{ environmentId: "env_prod", state: "attention", srm: false, guardrail: true }],
    };

    expect(appAttentionSeverity(app(mixed))).toBe("attention");
    expect(appAttentionSummary(app(mixed))).toBe("Needs attention in prod");
  });
});

describe("Create App role matrix", () => {
  it("admits owner and admin only", () => {
    expect(canCreateApp("owner")).toBe(true);
    expect(canCreateApp("admin")).toBe(true);
    expect(canCreateApp("member")).toBe(false);
  });
});
