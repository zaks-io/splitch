import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FlagDetailView } from "#lib/flag-detail-view";
import { FlagDetailPage } from "./flag-detail-page";

const scopeHref = "/acme-labs/checkout-api/dev";

describe("Flag detail page", () => {
  it("leads with this Environment's Configuration and labels the shared definition", () => {
    const html = render(view());

    expect(html).toContain("Configuration in");
    expect(html).toContain("Definition — shared across all environments");
    // The primary content comes first: the order on the page is the message that
    // the Environment config, not the App-level catalog, is what you came to read.
    expect(html.indexOf("Configuration in")).toBeLessThan(
      html.indexOf("Definition — shared across all environments"),
    );
  });

  it("renders the per-Variant availability toggle STATE without making it togglable", () => {
    const html = render(view());

    expect(html).toContain("available in dev");
    expect(html).toContain('data-variant-availability="available"');
    expect(html).toContain('data-variant-availability="unavailable"');
    // Every switch on this read-only screen is frozen. A single enabled one would
    // promise a mutation this slice does not implement.
    const switches = html.match(/data-slot="switch"/g) ?? [];
    const disabled = html.match(/data-slot="switch"[^>]*data-disabled/g) ?? [];
    expect(switches).toHaveLength(2);
    expect(disabled).toHaveLength(switches.length);
  });

  it("makes an unavailable Variant visibly distinct, not merely absent from a count", () => {
    const html = render(view());

    expect(html).toContain("Not available");
    expect(html).toContain('data-variant-name="treatment"');
  });

  it("banners the controlling Experiment, locks its fields, and leaves the kill switch open", () => {
    const html = render(
      view({ controllingExperiment: { id: "exp_1", name: "Checkout Copy Dev" } }),
    );

    expect(html).toContain("Controlled by Experiment");
    expect(html).toContain("Checkout Copy Dev");
    expect(html).toContain(`href="${scopeHref}/experiments/exp_1"`);
    expect(html).toContain("owned by Experiment Checkout Copy Dev while it runs");
    // The kill switch section must carry no lock marker: an operator has to be able
    // to turn the Flag off during an incident.
    const killSwitch = section(html, "Kill switch");
    expect(killSwitch).not.toContain('data-flag-lock="true"');
    expect(killSwitch).toContain("Never locked");
  });

  it("shows no banner and no lock when no Experiment controls the Flag here", () => {
    const html = render(view());

    expect(html).not.toContain("Controlled by Experiment");
    expect(html).not.toContain('data-flag-lock="true"');
  });

  it("says outright that an unconfigured Environment serves nothing", () => {
    const html = render(
      view({
        configured: false,
        enabled: false,
        availableVariantCount: 0,
        availabilityNarrowed: false,
        targetingRules: [],
        catalog: view().catalog.map((variant) => ({
          ...variant,
          availability: "unavailable" as const,
        })),
      }),
    );

    expect(html).toContain("No Flag Configuration in this Environment yet");
    expect(html).toContain("Disabled");
  });

  it("does not claim an un-narrowed Configuration can serve nothing", () => {
    const html = render(
      view({
        availabilityNarrowed: false,
        availableVariantCount: 0,
        catalog: view().catalog.map((variant) => ({
          ...variant,
          availability: "not-narrowed" as const,
        })),
      }),
    );

    expect(html).toContain('data-flag-availability="not-narrowed"');
    expect(html).toContain("every Variant in the catalog is a candidate");
  });

  it("never renders the server-minted rollout salt", () => {
    const html = render(view());

    expect(html).not.toContain("salt");
  });
});

function render(next: FlagDetailView): string {
  return renderToStaticMarkup(<FlagDetailPage scopeHref={scopeHref} view={next} />);
}

function section(html: string, label: string): string {
  const start = html.indexOf(`aria-label="${label}"`);
  const end = html.indexOf("aria-label=", start + 1);
  return html.slice(start, end === -1 ? undefined : end);
}

function view(overrides: Partial<FlagDetailView> = {}): FlagDetailView {
  return {
    key: "new-checkout",
    name: "New Checkout",
    env: "dev",
    schema: '{"type":"boolean"}',
    configured: true,
    enabled: true,
    catalog: [
      {
        id: "var_control",
        name: "control",
        value: "false",
        isDefault: true,
        availability: "available",
      },
      {
        id: "var_treatment",
        name: "treatment",
        value: "true",
        isDefault: false,
        availability: "unavailable",
      },
    ],
    availableVariantCount: 1,
    availabilityNarrowed: true,
    defaultVariantName: "control",
    targetingRules: [
      {
        id: "rule_dev",
        priority: 0,
        variantName: "treatment",
        conditions: [{ attribute: "plan", operator: "eq", value: '"pro"' }],
        rolloutPercentage: 25,
      },
    ],
    baselineRolloutPercentage: null,
    controllingExperiment: null,
    ...overrides,
  };
}
