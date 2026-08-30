import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FlagDetailView } from "#lib/flags/flag-detail-view";
import { promotionView, stagingView } from "#lib/promotions/promotion-fixture";
import { PromotionPage } from "#components/promotions/promotion-page";

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: () => Promise.resolve() }),
}));

vi.mock("#lib/flags/control-plane-flag-mutations", () => ({
  promoteControlPanelFlagConfig: vi.fn(),
  loadControlPanelApprovalRequest: vi.fn(),
  reviewControlPanelApprovalRequest: vi.fn(),
}));

const scopeHref = "/acme-labs/checkout-api/prod";
const sourceOptions = [
  { env: "dev", environmentId: "env_dev" },
  { env: "staging", environmentId: "env_staging" },
];

describe("Promotion page", () => {
  it("frames the write as a pull into the Environment whose Policy governs", () => {
    const html = render();

    expect(html).toContain("Promote from");
    expect(html).toContain('data-promotion-source="staging"');
    expect(html).toContain('data-promotion-target="prod"');
    expect(html).toContain("Promote into prod");
  });

  it("renders one tickable row per differing field group, and none for a matching one", () => {
    const html = render();

    expect(rowKinds(html)).toEqual(["availability", "targeting", "rollout", "enabled"]);
    expect(html).toContain('data-promotion-row="availability:beta"');
    // The two Variants that match in both Environments get no row at all: a
    // tickable no-op would be a lie about what the payload contains.
    expect(html).not.toContain('data-promotion-row="availability:control"');
    expect(html).not.toContain('data-promotion-row="availability:holdout"');
  });

  it("starts with nothing ticked and a payload that says so", () => {
    const html = render();

    expect(html).toContain('data-promotion-payload="{}"');
    expect(html).toContain("Nothing ticked yet.");
    expect(html).not.toContain('data-promotion-row-selected="true"');
  });

  it("offers presets that only pre-tick rows already on the screen", () => {
    const html = render();

    expect(html).toContain('data-promotion-preset="whole"');
    expect(html).toContain('data-promotion-preset="availability"');
    expect(html).toContain('data-promotion-preset="variant:beta"');
  });

  it("shows both sides of every row rather than only what changes", () => {
    const html = render();

    expect(html).toContain('data-promotion-value="target"');
    expect(html).toContain('data-promotion-value="source"');
    expect(html).toContain("Now in ");
    expect(html).toContain("From ");
    // The target's current value, not only the incoming one: a one-sided list is a
    // changelog, and this screen has to be a diff.
    expect(html).toContain("No baseline rollout");
    expect(html).toContain("10% of traffic");
  });

  it("names the field groups it read and found identical", () => {
    const html = render(stagingView(), stagingView({ env: "prod", enabled: false }));

    expect(html).toContain('data-promotion-identical="true"');
    expect(html).toContain("Variant availability");
    expect(html).toContain("Targeting Rules");
  });

  it("says outright when the two Environments already match", () => {
    const html = render(stagingView(), stagingView({ env: "prod" }));

    expect(html).toContain('data-promotion-empty="true"');
    expect(html).toContain("nothing to promote");
    expect(html).not.toContain('data-promotion-submit="true"');
  });

  it("warns that promoting from an un-narrowed source removes Variants", () => {
    const source = promotionView({
      env: "staging",
      availabilityNarrowed: false,
      catalog: promotionView().catalog.map((variant) => ({
        ...variant,
        availability: "not-narrowed" as const,
      })),
    });

    const html = render(source, stagingView({ env: "prod" }));

    expect(html).toContain('data-promotion-source-not-narrowed="true"');
    expect(html).toContain("REMOVES");
  });

  it("lets the operator switch source Environments through the URL", () => {
    const html = render();

    expect(html).toContain('data-promotion-source-option="dev"');
    expect(html).toContain(`href="${scopeHref}/flags/new-checkout/promote?from=staging"`);
  });
});

function render(source: FlagDetailView = stagingView(), target = promotionView()): string {
  return renderToStaticMarkup(
    <PromotionPage
      appId="app_1"
      scopeHref={scopeHref}
      source={source}
      sourceEnvironmentId="env_staging"
      sourceOptions={sourceOptions}
      target={target}
      targetEnvironmentId="env_prod"
    />,
  );
}

function rowKinds(html: string): string[] {
  return [...html.matchAll(/data-promotion-row-kind="([^"]+)"/g)].map(
    (match) => match[1] as string,
  );
}
