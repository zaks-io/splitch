import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FlagsMatrixData } from "#lib/flags/flags-matrix-data";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children?: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const { FlagCreatedNotice } = await import("#components/flags/flag-created-notice");
const matrix: FlagsMatrixData = {
  readLimit: 200,
  readTruncated: false,
  rows: [
    {
      definition: {
        id: "flag_1",
        key: "new-checkout",
        variantCount: 2,
        variantLabels: {},
      },
      cells: { env_dev: null },
    },
  ],
};

describe("FlagCreatedNotice", () => {
  it("shows the new definition and dismisses to the App home", () => {
    const html = renderToStaticMarkup(
      <FlagCreatedNotice
        appSlug="checkout-api"
        createdKey="new-checkout"
        matrix={matrix}
        orgSlug="acme-labs"
      />,
    );
    expect(html).toContain("It is disabled in every Environment until you switch it on.");
    expect(html).toContain("flag_config_update");
    expect(html).toContain('href="/acme-labs/checkout-api"');
  });

  it("renders nothing for a stale created key", () => {
    const html = renderToStaticMarkup(
      <FlagCreatedNotice
        appSlug="checkout-api"
        createdKey="unknown"
        matrix={matrix}
        orgSlug="acme-labs"
      />,
    );
    expect(html).toBe("");
  });
});
