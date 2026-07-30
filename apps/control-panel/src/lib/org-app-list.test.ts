import { describe, expect, it } from "vitest";
import {
  type AppAttention,
  appAttentionSummary,
  attentionLabel,
  canCreateApp,
  environmentAttention,
  type OrgAppListApp,
} from "./org-app-list";

const environments = [
  { environmentId: "env_dev", env: "dev", name: "Development" },
  { environmentId: "env_prod", env: "prod", name: "Production" },
];

function app(attention: AppAttention): OrgAppListApp {
  return { appId: "app_checkout", appSlug: "checkout-api", environments, attention };
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
});

describe("Create App role matrix", () => {
  it("admits owner and admin only", () => {
    expect(canCreateApp("owner")).toBe(true);
    expect(canCreateApp("admin")).toBe(true);
    expect(canCreateApp("member")).toBe(false);
  });
});
