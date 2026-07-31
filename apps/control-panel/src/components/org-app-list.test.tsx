import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppAttention, OrgAppListApp } from "#lib/org-app-list";
import { AppListCard } from "./app-list-card";

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: () => {} }),
  useRouterState: () => "/",
}));
vi.mock("#lib/control-plane-app-functions", () => ({ createControlPanelApp: vi.fn() }));
vi.mock("#lib/control-plane-organization-functions", () => ({
  createControlPanelOrganization: vi.fn(),
}));

const { AppsEmptyState } = await import("./apps-empty-state");
const { CreateAppDialog } = await import("./create-app-dialog");
const { OrganizationChooser } = await import("./organization-chooser");

const environments = [
  { environmentId: "env_dev", env: "dev", name: "Development" },
  { environmentId: "env_prod", env: "prod", name: "Production" },
];

function card(attention: AppAttention) {
  const app: OrgAppListApp = {
    appId: "app_checkout",
    appSlug: "checkout-api",
    environments,
    attention,
  };
  return renderToStaticMarkup(<AppListCard app={app} orgSlug="acme-labs" />);
}

const ready: AppAttention = {
  kind: "ready",
  items: [
    { environmentId: "env_dev", state: "clear", srm: false, guardrail: false },
    { environmentId: "env_prod", state: "attention", srm: true, guardrail: false },
  ],
};

describe("App card", () => {
  it("is the Environment picker: one link per Environment, and none to the bare App", () => {
    const html = card(ready);

    expect(html).toContain('href="/acme-labs/checkout-api/dev"');
    expect(html).toContain('href="/acme-labs/checkout-api/prod"');
    // The App name is a heading, not a link. Nothing offers an App without an
    // Environment, because that destination would have to guess one.
    expect(html).toContain("<h3");
    expect(html).not.toContain('href="/acme-labs/checkout-api"');
  });

  it("marks only the Environment that needs attention", () => {
    const html = card(ready);

    expect(html).toContain('data-attention-environment-id="env_prod"');
    expect(html).toContain('data-attention-state="attention"');
    expect(html).not.toContain('data-attention-environment-id="env_dev"');
    expect(html).toContain("Needs attention in prod");
  });

  it("keeps the marker out of the link's accessible name", () => {
    // A dot nested in the link would rename it; describedby never contributes to
    // the accessible name, so the link stays "Production".
    const html = card(ready);

    expect(html).toContain('aria-describedby="attention-env_prod"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("Production needs attention: Sample Ratio Mismatch firing.");
  });

  it("states why health is missing rather than rendering a calm card", () => {
    const html = card({ kind: "unavailable", message: "the Control Plane could not be reached" });

    expect(html).toContain("Experiment health unavailable");
    expect(html).toContain("the Control Plane could not be reached");
    expect(html).toContain('data-attention-state="unknown"');
  });

  it("never renders the calm headline when an Environment is missing from the rollup", () => {
    // SPL-202: the SPL-103 review scenario, at the render site. The rollup
    // succeeded for env_dev only; env_prod is silently absent. This must not
    // read as "No Experiment needs attention" — that sentence asserts health
    // that was never measured (ADR-0036).
    const html = card({
      kind: "ready",
      items: [{ environmentId: "env_dev", state: "clear", srm: false, guardrail: false }],
    });

    expect(html).toContain("Health unknown in prod");
    expect(html).not.toContain("No Experiment needs attention");
    expect(html).toContain('data-app-attention-severity="unknown"');
  });

  it("keeps a confirmed problem visible even when another Environment in the App is unknown", () => {
    const html = card({
      kind: "ready",
      items: [{ environmentId: "env_prod", state: "attention", srm: true, guardrail: false }],
    });

    expect(html).toContain("Needs attention in prod");
    expect(html).not.toContain("Health unknown");
    expect(html).toContain('data-app-attention-severity="attention"');
  });

  it("calls out an App with no Environments as broken, not empty", () => {
    const html = renderToStaticMarkup(
      <AppListCard
        app={{ appId: "app_x", appSlug: "x", environments: [], attention: ready }}
        orgSlug="acme-labs"
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("This App has no Environments.");
  });
});

describe("Create App affordance", () => {
  it("offers the action to an owner", () => {
    const html = renderToStaticMarkup(<CreateAppDialog orgId="org_1" orgRole="owner" />);

    expect(html).toContain('data-testid="create-app"');
    expect(html).not.toContain('data-testid="create-app-locked"');
  });

  it("renders it locked, with the reason, for a member", () => {
    const html = renderToStaticMarkup(<CreateAppDialog orgId="org_1" orgRole="member" />);

    expect(html).toContain('data-testid="create-app-locked"');
    expect(html).toContain("Create App (locked)");
    expect(html).toContain(" disabled=");
  });
});

describe("Apps empty state", () => {
  it("teaches the concept, offers the action, and gives the CLI/agent equivalent", () => {
    const html = renderToStaticMarkup(<AppsEmptyState orgId="org_1" orgRole="owner" />);

    expect(html).toContain("Create your first App");
    expect(html).toContain("An App holds your Flags and Experiments");
    expect(html).toContain("splitch apps create");
    expect(html).toContain("apps_create");
    expect(html).toContain('data-testid="create-app"');
  });

  it("tells a member who can create the App instead", () => {
    const html = renderToStaticMarkup(<AppsEmptyState orgId="org_1" orgRole="member" />);

    expect(html).toContain("Ask an Organization owner or admin to create the first App.");
    expect(html).not.toContain("splitch apps create");
  });
});

describe("Organization chooser", () => {
  it("makes every Organization a link into its own App list", () => {
    const html = renderToStaticMarkup(
      <OrganizationChooser
        orgs={[
          {
            orgId: "org_1",
            orgSlug: "acme-labs",
            orgRole: "owner",
            isProvisional: false,
            demoExpiresAt: null,
            apps: [{ appId: "app_checkout", appSlug: "checkout-api", role: "owner" }],
          },
        ]}
      />,
    );

    expect(html).toContain('href="/acme-labs"');
    expect(html).toContain("checkout-api");
    // Apps belong to the Organization card that owns them; there is no bare-App
    // link here either.
    expect(html).not.toContain('href="/acme-labs/checkout-api"');
  });

  // SPL-205: zero memberships used to render a sentence and nothing else, which
  // made the first screen of the product a dead end.
  it("offers the Create Organization path when the user belongs to no Organization", () => {
    const html = renderToStaticMarkup(<OrganizationChooser orgs={[]} />);

    expect(html).toContain("Create your first Organization");
    expect(html).toContain('data-testid="create-organization"');
  });

  it("keeps a Create Organization path once the user already belongs to one", () => {
    const html = renderToStaticMarkup(
      <OrganizationChooser
        orgs={[
          {
            orgId: "org_2",
            orgSlug: "orbit-tools",
            orgRole: "admin",
            isProvisional: false,
            demoExpiresAt: null,
            apps: [],
          },
        ]}
      />,
    );

    expect(html).toContain('data-testid="create-organization"');
  });
});
