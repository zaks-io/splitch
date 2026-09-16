import { describe, expect, it } from "vitest";
import { formatPrincipalFlags } from "./format-principal-flags.js";

const timestamp = "2026-08-28T00:00:00.000Z";

describe("formatPrincipalFlags", () => {
  it("groups hydrated Flags by App using the App-scoped labeled sections", () => {
    const output = formatPrincipalFlags(hydratedPage(), false);

    expect(output).toMatchInlineSnapshot(`
      "App: alpha/checkout (app_checkout)
      Flag: sales-tax
      ID: flag_tax
      App: app_checkout
      Key: sales-tax
      Schema: (none)
      Default Variant ID: var_flag_tax
      Created: 2026-08-28T00:00:00.000Z
      Updated: 2026-08-28T00:00:00.000Z

      Variants
      VARIANT ID    NAME     VALUE  DESCRIPTION
      var_flag_tax  control  false

      Configurations
      Environment: env_app_checkout_prod
      Enabled: true
      Available Variants: control
      Rollout: (none)
      Experiment: (none)
      Targeting Rules: (none)

      App: alpha/search (app_search)
      Flag: ranking
      ID: flag_rank
      App: app_search
      Key: ranking
      Schema: (none)
      Default Variant ID: var_flag_rank
      Created: 2026-08-28T00:00:00.000Z
      Updated: 2026-08-28T00:00:00.000Z

      Variants
      VARIANT ID     NAME     VALUE  DESCRIPTION
      var_flag_rank  control  false

      Configurations
      Environment: env_app_search_prod
      Enabled: true
      Available Variants: control
      Rollout: (none)
      Experiment: (none)
      Targeting Rules: (none)

      App: beta/billing (app_billing)
      Flag: invoice
      ID: flag_invoice
      App: app_billing
      Key: invoice
      Schema: (none)
      Default Variant ID: var_flag_invoice
      Created: 2026-08-28T00:00:00.000Z
      Updated: 2026-08-28T00:00:00.000Z

      Variants
      VARIANT ID        NAME     VALUE  DESCRIPTION
      var_flag_invoice  control  false

      Configurations
      Environment: env_app_billing_prod
      Enabled: true
      Available Variants: control
      Rollout: (none)
      Experiment: (none)
      Targeting Rules: (none)"
    `);
    expect(output).not.toContain("{");
  });

  it("keeps same-App Flags under one header and stacks them like App-scoped list", () => {
    const output = formatPrincipalFlags(
      page([
        principalFlag("org_alpha", "alpha", "app_checkout", "checkout", "flag_tax", "sales-tax"),
        principalFlag("org_alpha", "alpha", "app_checkout", "checkout", "flag_promo", "promo"),
      ]),
      false,
    );

    expect(output.startsWith("App: alpha/checkout (app_checkout)\nFlag: sales-tax")).toBe(true);
    expect(output).toContain("\n\nFlag: promo\n");
    expect(output.match(/App: alpha\/checkout/g)).toEqual(["App: alpha/checkout"]);
  });

  it("prints compact ID/KEY/NAME columns per App for --summary", () => {
    const output = formatPrincipalFlags(summaryPage(), true);

    expect(output).toMatchInlineSnapshot(`
      "App: alpha/checkout (app_checkout)
      ID        KEY        NAME
      flag_tax  sales-tax  sales-tax

      App: alpha/search (app_search)
      ID         KEY      NAME
      flag_rank  ranking  ranking

      App: beta/billing (app_billing)
      ID            KEY      NAME
      flag_invoice  invoice  invoice"
    `);
    expect(output).not.toContain("{");
  });

  it("names an empty catalog instead of printing a blank line", () => {
    expect(formatPrincipalFlags(page([]), false)).toBe("No Flags found.");
    expect(formatPrincipalFlags(page([]), true)).toBe("No Flags found.");
  });

  it("says a truncated catalog is incomplete in both human modes", () => {
    const notice = "Truncated: more than 200 Flags exist; 200 are shown.";
    expect(formatPrincipalFlags({ ...hydratedPage(), readTruncated: true }, false)).toContain(
      notice,
    );
    expect(formatPrincipalFlags({ ...summaryPage(), readTruncated: true }, true)).toContain(notice);
    expect(formatPrincipalFlags({ ...page([]), readTruncated: true }, false)).toContain(notice);
  });

  it("escapes stored terminal controls in App group headers", () => {
    const output = formatPrincipalFlags(
      page([
        principalFlag(
          "org_alpha",
          "alpha",
          "app_checkout\u202e",
          "checkout\u001b[2J",
          "flag_tax",
          "sales-tax",
        ),
      ]),
      false,
    );

    expect(output).toContain("App: alpha/checkout\\u001b[2J (app_checkout\\u202e)");
    expect(output).not.toContain("\u001b");
  });

  it("fails loud when a hydrated read omits Configurations", () => {
    expect(() => formatPrincipalFlags(summaryPage(), false)).toThrow(
      /principal_flags_list requested complete Flag Configurations/,
    );
  });

  it("fails loud when a summary read is not the compact contract", () => {
    expect(() => formatPrincipalFlags(hydratedPage(), true)).toThrow(
      /principal_flags_list requested a compact Flag summary/,
    );
  });
});

function hydratedPage() {
  return page([
    principalFlag("org_alpha", "alpha", "app_checkout", "checkout", "flag_tax", "sales-tax"),
    principalFlag("org_alpha", "alpha", "app_search", "search", "flag_rank", "ranking"),
    principalFlag("org_beta", "beta", "app_billing", "billing", "flag_invoice", "invoice"),
  ]);
}

function summaryPage() {
  const hydrated = hydratedPage();
  return {
    ...hydrated,
    items: hydrated.items.map(({ configurations: _configurations, ...flag }) => flag),
  };
}

function page(items: ReturnType<typeof principalFlag>[]) {
  return {
    readTruncated: false,
    readLimit: 200,
    cursor: null,
    items,
  };
}

function principalFlag(
  orgId: string,
  orgSlug: string,
  appId: string,
  appKey: string,
  flagId: string,
  flagKey: string,
) {
  return {
    id: flagId,
    appId,
    key: flagKey,
    name: flagKey,
    schema: null,
    variants: [{ id: `var_${flagId}`, name: "control", value: false }],
    defaultVariantId: `var_${flagId}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    org: { id: orgId, slug: orgSlug },
    app: { id: appId, key: appKey },
    configurations: [
      {
        environmentId: `env_${appId}_prod`,
        enabled: true,
        availableVariantNames: ["control"],
        targetingRules: [],
        rollout: null,
        experiment: null,
      },
    ],
  };
}
