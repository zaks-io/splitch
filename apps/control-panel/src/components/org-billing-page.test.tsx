import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrgBillingPage } from "#components/org-billing-page";
import type { OrgBillingView, OrgUsage } from "#lib/org-billing";
import { toUsageDimensions } from "#lib/org-billing";

const PERIOD = {
  month: "2026-08",
  startsAt: "2026-08-01T00:00:00Z",
  endsAt: "2026-09-01T00:00:00Z",
};

const populated: OrgUsage = {
  kind: "ready",
  period: PERIOD,
  evaluations: 1000,
  dimensions: toUsageDimensions(
    {
      byApp: [
        { appId: "app_1", evaluations: 700 },
        { appId: "app_2", evaluations: 300 },
      ],
      byEnvironment: [{ environmentId: "env_1", evaluations: 1000 }],
      byFlag: [{ flagKey: "checkout-redesign", evaluations: 1000 }],
      bySdkRuntime: [{ sdkRuntime: "node", evaluations: 1000 }],
      byBatch: [{ mode: "batch", evaluations: 1000 }],
      bySource: [{ source: "cached", evaluations: 1000 }],
      byExposure: [{ exposure: "bearing", evaluations: 250 }],
    },
    {
      apps: new Map([
        ["app_1", "Checkout API"],
        ["app_2", "Marketing Site"],
      ]),
      environments: new Map([["env_1", "Checkout API · Production"]]),
    },
  ),
};

function view(overrides: Partial<OrgBillingView> = {}): OrgBillingView {
  return {
    orgSlug: "kiln-works",
    orgRole: "owner",
    plan: "free",
    hasBillingAccount: false,
    usage: populated,
    ...overrides,
  };
}

describe("OrgBillingPage usage", () => {
  it("renders every reporting dimension against the month total", () => {
    const html = renderToStaticMarkup(<OrgBillingPage view={view()} />);

    expect(html).toContain('data-usage-state="populated"');
    expect(html).toContain("1,000");
    for (const dimension of [
      "app",
      "environment",
      "flag",
      "sdk-runtime",
      "batch",
      "source",
      "exposure",
    ]) {
      expect(html).toContain(`data-usage-dimension="${dimension}"`);
    }
    // 700 of a 1,000-Evaluation month is 70% of the month — not 100% because it
    // happens to be the largest row on screen.
    expect(html).toContain("width:70%");
    expect(html).toContain("Checkout API");
    // Resource ids stay in the test hooks and out of the copy.
    const copy = html.replace(/<[^>]*>/g, " ");
    expect(copy).not.toContain("app_1");
    expect(copy).not.toContain("env_1");
  });

  it("states an empty month instead of drawing an empty breakdown", () => {
    const html = renderToStaticMarkup(
      <OrgBillingPage
        view={view({
          usage: { kind: "ready", period: PERIOD, evaluations: 0, dimensions: [] },
        })}
      />,
    );

    expect(html).toContain('data-usage-state="zero"');
    expect(html).toContain("Nothing evaluated yet");
    expect(html).toContain("August 2026");
    expect(html).not.toContain("data-usage-dimension");
  });

  it("says a failed read failed, and never renders it as a zero month", () => {
    const html = renderToStaticMarkup(
      <OrgBillingPage
        view={view({ usage: { kind: "unavailable", message: "analysis usage is unavailable" } })}
      />,
    );

    expect(html).toContain('data-usage-state="unavailable"');
    expect(html).toContain("analysis usage is unavailable");
    expect(html).not.toContain('data-usage-total=""');
  });
});

describe("OrgBillingPage quota and payment", () => {
  it("shows quota enforcement as deferred, never as a live runtime state", () => {
    const html = renderToStaticMarkup(<OrgBillingPage view={view()} />);

    expect(html).toContain('data-quota-state="deferred"');
    expect(html).toContain("No limit is enforced");
    // Active / Grace / Exhausted are ADR-0033 states of an enforcement path that
    // does not run yet, so the panel must not claim any of them.
    expect(html).not.toMatch(/\bGrace\b|\bExhausted\b/);
  });

  it("stubs payment in the open rather than faking a card or an invoice", () => {
    const html = renderToStaticMarkup(<OrgBillingPage view={view()} />);

    expect(html).toContain('data-payment-state="stubbed"');
    expect(html).toContain("Free");
    expect(html).toContain("no payment method or invoice to show");
  });

  it("locks managing the plan for everyone but an owner", () => {
    const owner = renderToStaticMarkup(<OrgBillingPage view={view()} />);
    const admin = renderToStaticMarkup(<OrgBillingPage view={view({ orgRole: "admin" })} />);

    expect(owner).toContain('data-testid="manage-plan"');
    expect(owner).not.toContain('data-testid="manage-plan-locked"');
    expect(admin).toContain('data-testid="manage-plan-locked"');
    expect(admin).toContain("disabled");
  });
});
