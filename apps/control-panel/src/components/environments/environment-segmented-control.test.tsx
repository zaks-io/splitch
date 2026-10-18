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
          { env: "dev", guarded: false, temporary: null },
          { env: "prod", guarded: true, temporary: null },
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
  it("groups Temporary Environments after permanent tabs and shows expiry", () => {
    const html = renderToStaticMarkup(
      <EnvironmentSegmentedControl
        active="pr-123"
        appSlug="checkout"
        orgSlug="acme"
        section="flags"
        environments={[
          {
            env: "pr-123",
            guarded: false,
            temporary: {
              expiresAt: "2026-10-20T12:00:00.000Z",
              syncedAt: "2026-10-18T12:00:00.000Z",
              syncedFromEnvironmentId: "env_prod",
            },
          },
          { env: "prod", guarded: true, temporary: null },
        ]}
      />,
    );
    expect(html).toContain('aria-label="Temporary Environments"');
    expect(html.indexOf('data-environment-segment="prod"')).toBeLessThan(
      html.indexOf('data-environment-segment="pr-123"'),
    );
    expect(html).toContain("20 Oct 2026, 12:00 UTC");
    expect(html).not.toContain("env_prod");
    expect(html.match(/data-active=""/g)).toHaveLength(1);
  });
});
