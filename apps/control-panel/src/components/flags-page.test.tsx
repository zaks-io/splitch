import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FlagsEmptyState } from "./flags-empty-state";
import { FlagsTable } from "./flags-table";
import { FlagsTruncatedNotice } from "./flags-truncated-notice";

vi.mock("./create-flag-dialog", () => ({
  CreateFlagDialog: () => <button type="button">Create Flag</button>,
}));

describe("Flags page", () => {
  it("links each row to the Flag detail screen in the active Environment", () => {
    const html = renderToStaticMarkup(
      <FlagsTable
        env="dev"
        items={[
          {
            definition: { id: "flag_checkout", key: "new-checkout", variantCount: 2 },
            configuration: {
              enabled: true,
              availableVariantCount: 2,
              rolloutPercentages: [25],
            },
          },
        ]}
        scopeHref="/acme-labs/checkout-api/dev"
      />,
    );

    expect(html).toContain("Flag Configuration in");
    expect(html).toContain("new-checkout");
    expect(html).toContain("Enabled");
    expect(html).toContain("25% rollout");
    expect(html).toContain("2 of 2");
    // The key, not the id: the key is the addressable identity and is what the
    // operator already knows from the CLI and the SDK.
    expect(html).toContain('href="/acme-labs/checkout-api/dev/flags/new-checkout"');
    expect(html).not.toContain("flag_checkout");
  });

  it("teaches the Flag concept and the CLI/MCP equivalents in the empty state", () => {
    const html = renderToStaticMarkup(
      <FlagsEmptyState appId="app_checkout" environmentId="env_dev" />,
    );

    expect(html).toContain("Create your first Flag");
    expect(html).toContain("A Flag is a named toggle with Variants.");
    expect(html).toContain("splitch flags create");
    expect(html).toContain("flags_create");
  });

  it("says the table is a page of the catalog, without promising a remedy that does not exist", () => {
    const html = renderToStaticMarkup(<FlagsTruncatedNotice readLimit={200} shownCount={200} />);

    expect(html).toContain("More than 200 Flags in this App");
    expect(html).toContain("The 200 below are the most recently created, not all of them.");
    // This screen IS the wider view, and the CLI and MCP read the same bounded
    // endpoint. Sending an operator anywhere would be an impossible remedy.
    expect(html).not.toContain("Reload");
    expect(html).not.toContain("splitch flags");
  });
});
