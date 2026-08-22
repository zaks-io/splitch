import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FlagsMatrixData } from "#lib/flags-matrix-data";
import type { EnvironmentScope } from "#lib/loader-context";

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: vi.fn() }),
}));
vi.mock("./environment-segmented-control", () => ({
  EnvironmentSegmentedControl: () => <div data-environment-segmented />,
}));
vi.mock("./create-flag-dialog", () => ({
  CreateFlagDialog: ({ environmentId, settingsHref }: Record<string, string>) => (
    <div data-create-environment={environmentId} data-settings-href={settingsHref} />
  ),
}));
vi.mock("./flag-created-notice", () => ({ FlagCreatedNotice: () => <div data-created-notice /> }));
vi.mock("./flags-matrix-table", () => ({ FlagsMatrixTable: () => <div data-matrix-table /> }));
vi.mock("./flags-empty-state", () => ({
  FlagsEmptyState: ({ environmentId }: { environmentId: string }) => (
    <div data-empty-environment={environmentId} />
  ),
}));

const { FlagsMatrixPage } = await import("./flags-matrix-page");
const environments: EnvironmentScope[] = [
  { environmentId: "env_prod", env: "prod", name: "Production", guarded: true },
  { environmentId: "env_dev", env: "dev", name: "Development", guarded: false },
];

describe("FlagsMatrixPage", () => {
  it("delegates creation to the first non-guarded Environment", () => {
    const html = renderToStaticMarkup(
      <FlagsMatrixPage
        appId="app_1"
        appSlug="checkout-api"
        createdKey="new-checkout"
        environments={environments}
        matrix={matrixWithRow()}
        orgSlug="acme-labs"
      />,
    );
    expect(html).toContain('data-create-environment="env_dev"');
    expect(html).toContain('data-settings-href="/acme-labs/checkout-api/dev/settings"');
    expect(html).toContain("data-created-notice");
    expect(html).toContain("data-matrix-table");
  });

  it("keeps the create action in the empty state", () => {
    const html = renderToStaticMarkup(
      <FlagsMatrixPage
        appId="app_1"
        appSlug="checkout-api"
        environments={environments}
        matrix={{ rows: [], readLimit: 200, readTruncated: false }}
        orgSlug="acme-labs"
      />,
    );
    expect(html).not.toContain("data-create-environment");
    expect(html).toContain('data-empty-environment="env_dev"');
  });
});

function matrixWithRow(): FlagsMatrixData {
  return {
    readLimit: 200,
    readTruncated: false,
    rows: [
      {
        definition: { id: "flag_1", key: "new-checkout", variantCount: 2, variantLabels: {} },
        cells: { env_prod: null, env_dev: null },
      },
    ],
  };
}
