import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OrgAppListView } from "#lib/org-app-list";

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: () => {} }),
  useRouterState: () => "/",
}));
vi.mock("#lib/control-plane-app-functions", () => ({ createControlPanelApp: vi.fn() }));

const { OrgAppListPage } = await import("./org-app-list-page");

function view(overrides: Partial<OrgAppListView> = {}): OrgAppListView {
  return {
    orgId: "org_1",
    orgSlug: "kiln-works",
    orgRole: "owner",
    isProvisional: false,
    demoExpiresAt: null,
    apps: [],
    pendingAppResync: null,
    ...overrides,
  };
}

// SPL-203 fix round should-fix #1: `pendingAppResync` is read fresh from KV on
// every server render (unlike `create-app-dialog.tsx`'s local state), so this
// covers the reload-durability path the review flagged as silently lost, and
// the empty-state case that re-invited the impossible retry.
describe("OrgAppListPage pending resync", () => {
  it("shows nothing and the normal empty state when there is no pending resync and no Apps", () => {
    const html = renderToStaticMarkup(<OrgAppListPage view={view()} />);

    expect(html).not.toContain("session-stale");
    expect(html).toContain("Create your first App");
  });

  it("surfaces the durable notice on a fresh render (post-reload) with zero visible Apps", () => {
    const html = renderToStaticMarkup(
      <OrgAppListPage
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
    // The empty state must not re-invite a retry of a key that is already taken.
    expect(html).not.toContain("Create your first App");
  });

  it("shows the Create App action even with zero visible Apps once a resync is pending", () => {
    const html = renderToStaticMarkup(
      <OrgAppListPage
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
      <OrgAppListPage
        view={view({
          pendingAppResync: {
            appSlug: "checkout-api",
            reason: "control-panel session is missing its WorkOS session identifier",
            remedy: "reauth",
          },
        })}
      />,
    );

    expect(html).toContain('href="/auth/logout"');
    expect(html).not.toContain('data-testid="session-stale-reload"');
  });

  it("still lists Apps that the session does know about alongside the notice", () => {
    const html = renderToStaticMarkup(
      <OrgAppListPage
        view={view({
          apps: [
            {
              appId: "app_billing",
              appSlug: "billing-api",
              environments: [],
              attention: { kind: "ready", items: [] },
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
    expect(html).toContain("billing-api");
    expect(html).not.toContain("Create your first App");
  });
});
