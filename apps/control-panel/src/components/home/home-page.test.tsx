import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OrgAppListView } from "#lib/organizations/org-app-list";

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: () => {} }),
  useRouterState: () => "/",
}));
vi.mock("#lib/apps/control-plane-app-functions", () => ({ createControlPanelApp: vi.fn() }));

const { HomePage } = await import("#components/home/home-page");

function view(overrides: Partial<OrgAppListView> = {}): OrgAppListView {
  return {
    orgId: "org_1",
    orgSlug: "kiln-works",
    orgRole: "owner",
    isProvisional: false,
    demoExpiresAt: null,
    apps: [],
    pendingAppResync: null,
    lastVisited: null,
    now: 10_000,
    ...overrides,
  };
}

describe("HomePage", () => {
  it("renders the normal empty state and Needs-you scope when there are no Apps", () => {
    const html = renderToStaticMarkup(<HomePage view={view()} />);

    expect(html).not.toContain("session-stale");
    expect(html).toContain("Create your first App");
    expect(html).toContain("Experiment health across Apps");
    expect(html).toContain("Nothing needs you yet. This Organization has no Apps.");
  });

  it("labels App home and stale section hints without inventing a destination", () => {
    const appHome = renderToStaticMarkup(
      <HomePage
        view={view({
          lastVisited: {
            appSlug: "checkout-api",
            env: null,
            path: "/kiln-works/checkout-api",
            section: "flags",
            at: 9_000,
          },
        })}
      />,
    );
    const stale = renderToStaticMarkup(
      <HomePage
        view={view({
          lastVisited: {
            appSlug: "checkout-api",
            env: "dev",
            path: "/kiln-works/checkout-api/dev/retired",
            section: "retired",
            at: 9_000,
          },
        })}
      />,
    );

    expect(appHome).toContain("checkout-api · Flags across Environments");
    expect(stale).toContain("checkout-api / dev · retired");
  });

  it("gives each Needs-you link a destination-specific accessible name", () => {
    const html = renderToStaticMarkup(
      <HomePage
        view={view({
          apps: [
            {
              appId: "app_checkout",
              appSlug: "checkout-api",
              environments: [
                {
                  environmentId: "env_prod",
                  env: "prod",
                  name: "Production",
                  guarded: true,
                },
              ],
              attention: {
                kind: "unavailable",
                message: "analysis attention data is unavailable",
              },
              flags: { kind: "ready", count: 4, truncated: false },
            },
          ],
        })}
      />,
    );

    expect(html).toContain('aria-label="Open checkout-api Production"');
    expect(html).toContain('href="/kiln-works/checkout-api/prod"');
  });

  it("renders Continue before the two-column Home area when a visit is known", () => {
    const html = renderToStaticMarkup(
      <HomePage
        view={view({
          lastVisited: {
            appSlug: "checkout-api",
            env: "dev",
            path: "/kiln-works/checkout-api/dev/flags",
            section: "flags",
            at: 9_000,
          },
        })}
      />,
    );

    expect(html).toContain("data-continue-card");
    expect(html).toContain("checkout-api / dev · Flags");
    expect(html).toContain('href="/kiln-works/checkout-api/dev/flags"');
    expect(html.indexOf("Continue where you left off")).toBeLessThan(html.indexOf("Needs you"));
  });
});

describe("HomePage pending resync", () => {
  it("surfaces the durable notice on a fresh render with zero visible Apps", () => {
    const html = renderToStaticMarkup(
      <HomePage
        view={view({
          pendingAppResync: {
            appSlug: "checkout-api",
            reason: "unknown App role in session materialization",
            remedy: "retry",
          },
        })}
      />,
    );

    expect(html).toContain('data-testid="app-session-stale"');
    expect(html).toContain("The Control Plane said: unknown App role in session materialization");
    expect(html).not.toContain("Create your first App");
  });

  it("shows the Create App action with zero visible Apps once a resync is pending", () => {
    const html = renderToStaticMarkup(
      <HomePage
        view={view({
          pendingAppResync: {
            appSlug: "checkout-api",
            reason: "unknown App role in session materialization",
            remedy: "retry",
          },
        })}
      />,
    );

    expect(html).toContain('data-testid="create-app"');
  });

  it("offers reauth in the durable notice when the fault is reauth-fixable", () => {
    const html = renderToStaticMarkup(
      <HomePage
        view={view({
          pendingAppResync: {
            appSlug: "checkout-api",
            reason: "control-panel session is missing its WorkOS session identifier",
            remedy: "reauth",
          },
        })}
      />,
    );

    expect(html).toContain('action="/auth/logout" method="post"');
    expect(html).not.toContain('href="/auth/logout"');
    expect(html).not.toContain('data-testid="session-stale-reload"');
  });

  it("lists known Apps alongside a pending resync notice", () => {
    const html = renderToStaticMarkup(
      <HomePage
        view={view({
          apps: [
            {
              appId: "app_billing",
              appSlug: "billing-api",
              environments: [],
              attention: { kind: "ready", items: [] },
              flags: { kind: "unavailable", message: "This App has no Environments" },
            },
          ],
          pendingAppResync: {
            appSlug: "checkout-api",
            reason: "boom",
            remedy: "retry",
          },
        })}
      />,
    );

    expect(html).toContain('data-testid="app-session-stale"');
    expect(html).toContain('data-app-row="billing-api"');
    expect(html).not.toContain('href="/org-1/billing-api"');
    expect(html).toContain("Nothing needs you yet. No App has an Environment to watch.");
    expect(html).not.toContain("Create your first App");
  });
});
