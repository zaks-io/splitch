import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FlagsEmptyState } from "./flags-empty-state";
import { FlagsTable } from "./flags-table";

vi.mock("./create-flag-dialog", () => ({
  CreateFlagDialog: () => <button type="button">Create Flag</button>,
}));

describe("Flags page", () => {
  it("renders the active Environment configuration summary without a detail link", () => {
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
      />,
    );

    expect(html).toContain("Flag Configuration in");
    expect(html).toContain("new-checkout");
    expect(html).toContain("Enabled");
    expect(html).toContain("25% rollout");
    expect(html).toContain("2 of 2");
    expect(html).not.toContain("/acme-labs/checkout-api/dev/flags/new-checkout");
    expect(html).not.toContain("<a");
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
});
