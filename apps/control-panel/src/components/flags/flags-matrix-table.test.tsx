import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FlagsMatrixData } from "#lib/flags/flags-matrix-data";

vi.mock("#components/flags/flags-matrix-row", () => ({
  FlagsMatrixRow: ({ row }: { row: FlagsMatrixData["rows"][number] }) => (
    <tr data-flag-key={row.definition.key} />
  ),
}));

const { FlagsMatrixTable } = await import("#components/flags/flags-matrix-table");
const matrix: FlagsMatrixData = {
  readLimit: 200,
  readTruncated: false,
  rows: [
    {
      definition: { id: "flag_1", key: "checkout", variantCount: 2, variantLabels: {} },
      cells: { env_dev: null, env_prod: null },
    },
  ],
};

describe("FlagsMatrixTable", () => {
  it("names each Environment and the first-to-last Promotion pair", () => {
    const environments = [
      { environmentId: "env_dev", env: "dev", guarded: false },
      { environmentId: "env_prod", env: "prod", guarded: true },
    ];
    const html = renderToStaticMarkup(
      <FlagsMatrixTable
        appId="app_1"
        appSlug="checkout-api"
        delegationEnvironment={environments[0] as (typeof environments)[number]}
        environments={environments}
        matrix={matrix}
        orgSlug="acme-labs"
      />,
    );

    expect(html).toContain("dev");
    expect(html).toContain("prod");
    expect(html).toContain("dev → prod");
    expect(html).toContain('title="Policy confirms changes"');
  });

  it("omits the Promotion column for one Environment", () => {
    const environment = { environmentId: "env_dev", env: "dev", guarded: false };
    const html = renderToStaticMarkup(
      <FlagsMatrixTable
        appId="app_1"
        appSlug="checkout-api"
        delegationEnvironment={environment}
        environments={[environment]}
        matrix={{ ...matrix, rows: [] }}
        orgSlug="acme-labs"
      />,
    );
    expect(html).not.toContain("→");
  });
});
