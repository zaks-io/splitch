import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps, ReactNode } from "react";
import type { ScopeNavigation } from "#lib/loader-context";

let currentHref = "/acme-labs/checkout-api/dev/flags";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    activeOptions: _activeOptions,
    activeProps: _activeProps,
    children,
    hash,
    params,
    search,
    to,
    ...props
  }: MockLinkProps) => (
    <a
      {...props}
      data-link-hash={hash === true ? "preserve" : undefined}
      data-link-search={search === true ? "preserve" : undefined}
      data-link-to={to}
      href={routeHref(to, params, search, hash)}
    >
      {children}
    </a>
  ),
  useRouter: () => ({ history: { push: vi.fn() } }),
  useRouterState: ({ select }: { select: (state: MockRouterState) => unknown }) =>
    select({
      location: {
        href: currentHref,
        pathname: new URL(currentHref, "https://panel.splitch.dev").pathname,
      },
    }),
}));

const { PanelSidebar } = await import("./panel-sidebar");

type MockLinkProps = {
  activeOptions?: unknown;
  activeProps?: unknown;
  children: ReactNode;
  className?: string;
  "data-environment-pill"?: string;
  hash?: true;
  params?: Record<string, string | undefined>;
  search?: true;
  title?: string;
  to: string;
};

type MockRouterState = {
  location: { href: string; pathname: string };
};

function routeHref(
  to: string,
  params: MockLinkProps["params"],
  search: MockLinkProps["search"],
  hash: MockLinkProps["hash"],
): string {
  const path = params
    ? to
        .replace("$orgSlug", params.orgSlug ?? "")
        .replace("$appSlug", params.appSlug ?? "")
        .replace("$env", params.env ?? "")
    : to;
  const current = new URL(currentHref, "https://panel.splitch.dev");
  return `${path}${search === true ? current.search : ""}${hash === true ? current.hash : ""}`;
}

function navigation(multiOrg = false): ScopeNavigation {
  const orgs: ScopeNavigation["orgs"] = [
    {
      orgId: "org_1",
      orgSlug: "acme-labs",
      apps: [
        {
          appId: "app_checkout",
          appSlug: "checkout-api",
          environments: [
            {
              environmentId: "env_checkout_dev",
              env: "dev",
              guarded: false,
              name: "Development",
            },
            {
              environmentId: "env_checkout_prod",
              env: "prod",
              guarded: true,
              name: "Production",
            },
          ],
        },
        {
          appId: "app_billing",
          appSlug: "billing-api",
          environments: [
            {
              environmentId: "env_billing_dev",
              env: "dev",
              guarded: false,
              name: "Development",
            },
          ],
        },
        {
          appId: "app_agent",
          appSlug: "agent-console",
          environments: [
            {
              environmentId: "env_agent_prod",
              env: "prod",
              guarded: true,
              name: "Production",
            },
          ],
        },
      ],
    },
  ];
  if (multiOrg) {
    orgs.push({ orgId: "org_2", orgSlug: "orbit-tools", apps: [] });
  }
  return { orgs };
}

function renderSidebar(props: Partial<ComponentProps<typeof PanelSidebar>> = {}): string {
  return renderToStaticMarkup(
    <PanelSidebar
      navigation={navigation()}
      org={{ orgId: "org_1", orgSlug: "acme-labs" }}
      userId="user_1"
      {...props}
    />,
  );
}

describe("PanelSidebar", () => {
  it("renders App sections and preserves the current section across compatible Apps", () => {
    currentHref = "/acme-labs/checkout-api/dev/flags";
    const html = renderSidebar({
      app: { appId: "app_checkout", appSlug: "checkout-api", env: "dev" },
    });

    const labels = ["Flags", "Experiments", "Overview", "Segments", "Metrics", "Settings"];
    const positions = labels.map((label) => html.indexOf(`>${label}<`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain('data-environment-pill="dev"');
    expect(html).toContain('data-environment-pill="prod"');
    currentHref = "/acme-labs/checkout-api/prod/flags";
    const guardedHtml = renderSidebar({
      app: { appId: "app_checkout", appSlug: "checkout-api", env: "prod" },
    });
    expect(guardedHtml.match(/<a[^>]*data-environment-pill="prod"[^>]*>/u)?.[0]).toContain(
      "bg-warning-muted",
    );
    expect(html).toContain('href="/acme-labs/billing-api/dev/flags"');
    expect(html).toContain('href="/acme-labs/agent-console/prod"');
  });

  it("passes preserved search and hash through TanStack Link options", () => {
    currentHref = "/acme-labs/checkout-api/dev/flags?state=active#rule";
    const html = renderSidebar({
      app: { appId: "app_checkout", appSlug: "checkout-api", env: "dev" },
    });

    expect(html).toContain('href="/acme-labs/checkout-api/prod/flags?state=active#rule"');
    expect(html).toContain('data-link-to="/acme-labs/checkout-api/prod/flags"');
    expect(html).toContain('data-link-search="preserve"');
    expect(html).toContain('data-link-hash="preserve"');
  });

  it("renders an App chooser without App sections or Environment pills on Org screens", () => {
    currentHref = "/acme-labs/members";
    const html = renderSidebar();

    expect(html).toContain("Choose an App");
    expect(html).toContain("checkout-api");
    expect(html).toContain("billing-api");
    expect(html).not.toContain('aria-label="App sections"');
    expect(html).not.toContain("data-environment-pill");
  });

  it("renders exactly one POST sign-out form", () => {
    const html = renderSidebar();

    expect(html.match(/<form\b/gu) ?? []).toHaveLength(1);
    expect(html).toMatch(/<form[^>]*action="\/auth\/logout"[^>]*method="post"/u);
  });

  it("renders the Organization menu only for multi-Organization sessions", () => {
    const singleOrg = renderSidebar();
    const multiOrg = renderSidebar({ navigation: navigation(true) });

    expect(singleOrg.match(/<details/gu)).toHaveLength(1);
    expect(multiOrg.match(/<details/gu)).toHaveLength(2);
    expect(multiOrg).toContain("orbit-tools");
  });
});
