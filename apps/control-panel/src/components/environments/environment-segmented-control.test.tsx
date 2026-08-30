import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children?: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const { EnvironmentSegmentedControl } = await import(
  "#components/environments/environment-segmented-control"
);

describe("EnvironmentSegmentedControl", () => {
  it("links All environments to the App home and each Environment to the section", () => {
    const html = renderToStaticMarkup(
      <EnvironmentSegmentedControl
        active="all"
        appSlug="checkout-api"
        environments={[
          { env: "dev", guarded: false },
          { env: "prod", guarded: true },
        ]}
        orgSlug="acme-labs"
        section="flags"
      />,
    );

    expect(html).toContain('aria-label="Environment"');
    expect(html).toContain('data-environment-segment="all"');
    expect(html).toContain('href="/acme-labs/checkout-api"');
    expect(html).toContain('href="/acme-labs/checkout-api/dev/flags"');
    expect(html).toContain('href="/acme-labs/checkout-api/prod/flags"');
    expect(html.match(/data-active=""/g)).toHaveLength(1);
  });
});
