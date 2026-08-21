import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  DriftKind,
  FlagsMatrixCell,
  FlagsMatrixRow as MatrixRow,
} from "#lib/flags-matrix-data";

vi.mock("./flags-matrix-cell", () => ({
  FlagsMatrixCell: ({ env }: { env: string }) => <span data-matrix-cell={env} />,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children?: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const { FlagsMatrixRow } = await import("./flags-matrix-row");
const environments = [
  { environmentId: "env_dev", env: "dev" },
  { environmentId: "env_prod", env: "prod" },
];

describe("FlagsMatrixRow", () => {
  it.each([
    ["in-sync", "In sync"],
    ["enabled-differs", "Enabled differs"],
    ["rollout-differs", "Rollout differs"],
    ["missing-in-target", "Missing in prod"],
    ["missing-in-source", "Missing in dev"],
  ] as const)("renders the %s drift badge", (kind, copy) => {
    expect(renderRow(kind)).toContain(copy);
  });

  it("links Promotion to the target and carries the source Environment", () => {
    const html = renderRow("enabled-differs");
    expect(html).toContain("data-flag-promote-entry");
    expect(html).toContain(
      'href="/acme-labs/checkout-api/prod/flags/new-checkout/promote?from=dev"',
    );
  });

  it("renders no drift badge when neither Environment is configured", () => {
    const html = renderRow("unconfigured");
    expect(html).not.toContain("In sync");
    expect(html).not.toContain("data-flag-promote-entry");
  });
});

function renderRow(kind: DriftKind): string {
  const [source, target] = driftCells(kind);
  const row: MatrixRow = {
    definition: {
      id: "flag_1",
      key: "new-checkout",
      variantCount: 2,
      variantLabels: { var_off: "off", var_on: "on" },
    },
    cells: { env_dev: source, env_prod: target },
  };
  return renderToStaticMarkup(
    <FlagsMatrixRow
      appId="app_1"
      appSlug="checkout-api"
      created={false}
      delegationEnvironment={environments[0] as (typeof environments)[number]}
      environments={environments}
      orgSlug="acme-labs"
      row={row}
    />,
  );
}

function driftCells(kind: DriftKind): [FlagsMatrixCell | null, FlagsMatrixCell | null] {
  const enabled = cell(true, [25]);
  if (kind === "unconfigured") return [null, null];
  if (kind === "missing-in-target") return [enabled, null];
  if (kind === "missing-in-source") return [null, enabled];
  if (kind === "enabled-differs") return [enabled, cell(false, [25])];
  if (kind === "rollout-differs") return [enabled, cell(true, [50])];
  return [enabled, cell(true, [25])];
}

function cell(enabled: boolean, rolloutPercentages: number[]): FlagsMatrixCell {
  return { enabled, availableVariantCount: 2, rolloutPercentages, controllingExperiment: null };
}
