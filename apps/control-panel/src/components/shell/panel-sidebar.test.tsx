import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ScopeNavigation } from "#lib/shared/loader-context";

let currentHref = "/acme-labs/checkout-api/dev/flags";

// The sidebar reaches the create server function through the Create
// Organization dialog; nothing under test here calls it.
vi.mock("#lib/organizations/control-plane-organization-functions", () => ({
  createControlPanelOrganization: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    activeOptions: _activeOptions,
    activeProps: _activeProps,
    children,
    hash,
    params,
    preload,
    search,
    to,
    ...props
  }: MockLinkProps) => (
    <a
      {...props}
      data-link-hash={hash === true ? "preserve" : undefined}
      data-link-preload={preload === false ? "disabled" : undefined}
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

const { PanelSidebar } = await import("#components/shell/panel-sidebar");

type MockLinkProps = {
  activeOptions?: unknown;
  activeProps?: unknown;
  children: ReactNode;
  className?: string;
  "data-environment-pill"?: string;
  hash?: true;
  params?: Record<string, string | undefined>;
  preload?: false;
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
      onOpenPalette={() => undefined}
      org={{ orgId: "org_1", orgSlug: "acme-labs" }}
      userId="user_1"
      {...props}
    />,
  );
}

describe("PanelSidebar", () => {
  it("renders App sections and sends the App switcher to each App home", () => {
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
    expect(html).toContain('href="/acme-labs/agent-console/prod/flags"');
    expect(html.match(/data-link-preload="disabled"/gu)).toHaveLength(10);
  });

  it("keeps the current section while changing Apps", () => {
    currentHref = "/acme-labs/checkout-api/prod/experiments/experiment-1/results";
    const html = renderSidebar({
      app: { appId: "app_checkout", appSlug: "checkout-api", env: "prod" },
    });

    expect(html).toContain('href="/acme-labs/billing-api/dev/experiments"');
    expect(html).toContain('href="/acme-labs/agent-console/prod/experiments"');
  });

  it("keeps search and hash on Environment pill hrefs", () => {
    currentHref = "/acme-labs/checkout-api/dev/flags?state=active#rule";
    const html = renderSidebar({
      app: { appId: "app_checkout", appSlug: "checkout-api", env: "dev" },
    });

    expect(html).toContain('href="/acme-labs/checkout-api/prod/flags?state=active#rule"');
  });

  it("opens the Organization menu upward from the sidebar foot on App screens", () => {
    currentHref = "/acme-labs/checkout-api/dev/flags";
    const html = renderSidebar({
      app: { appId: "app_checkout", appSlug: "checkout-api", env: "dev" },
      navigation: navigation(true),
    });

    expect(html).toMatch(
      /<details[^>]*>(?:(?!<\/details>).)*Organization(?:(?!<\/details>).)*bottom-full/su,
    );
  });

  it("opens the Organization menu downward from the sidebar top on Org screens", () => {
    currentHref = "/acme-labs/members";
    const html = renderSidebar({ navigation: navigation(true) });

    expect(html).toMatch(
      /<details[^>]*>(?:(?!<\/details>).)*Organization(?:(?!<\/details>).)*top-full/su,
    );
  });

  it("lists every App as a direct link without sections or Environment pills on Org screens", () => {
    currentHref = "/acme-labs/members";
    const html = renderSidebar();

    expect(html).toContain('aria-label="Apps"');
    expect(html).toContain('href="/acme-labs/checkout-api"');
    expect(html).toContain('href="/acme-labs/billing-api"');
    expect(html).toContain('href="/acme-labs/agent-console"');
    expect(html).not.toContain("Choose an App");
    expect(html).not.toContain('aria-label="App sections"');
    expect(html).not.toContain("data-environment-pill");
  });

  it("keeps App sections stable with no active Environment on the App home", () => {
    currentHref = "/acme-labs/checkout-api";
    const html = renderSidebar({ app: { appId: "app_checkout", appSlug: "checkout-api" } });

    expect(html).toContain('href="/acme-labs/checkout-api/dev/flags"');
    expect(html).toContain('href="/acme-labs/checkout-api/prod/flags"');
    expect(html).toContain('aria-label="App sections"');
    expect(html).toMatch(
      /<nav aria-label="App sections"[^>]*>.*?<a[^>]*data-link-to="\/\$orgSlug\/\$appSlug"[^>]*href="\/acme-labs\/checkout-api"[^>]*>.*?>Flags</su,
    );
    expect(html).toContain('href="/acme-labs/checkout-api/dev/experiments"');
    const labels = ["Flags", "Experiments", "Overview", "Segments", "Metrics", "Settings"];
    const positions = labels.map((label) => html.indexOf(`>${label}<`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html.match(/data-environment-pill="dev"[^>]*bg-primary/u)).toBeNull();
  });

  it("links the brand mark home from the sidebar top", () => {
    const html = renderSidebar();

    expect(html).toMatch(/<a aria-label="splitch home"[^>]*href="\/"/u);
  });

  it("renders exactly one POST sign-out form", () => {
    const html = renderSidebar();

    expect(html.match(/<form\b/gu) ?? []).toHaveLength(1);
    expect(html).toMatch(/<form[^>]*action="\/auth\/logout"[^>]*method="post"/u);
  });

  it("offers Create Organization in the Organization section of every session", () => {
    expect(renderSidebar()).toMatch(/data-testid="create-organization"/u);
    expect(renderSidebar({ navigation: navigation(true) })).toMatch(
      /data-testid="create-organization"/u,
    );
  });

  it("renders the Organization menu only for multi-Organization sessions", () => {
    const singleOrg = renderSidebar();
    const multiOrg = renderSidebar({ navigation: navigation(true) });

    expect(singleOrg.match(/<details/gu)).toBeNull();
    expect(multiOrg.match(/<details/gu)).toHaveLength(1);
    expect(multiOrg).toContain("orbit-tools");
  });
});
