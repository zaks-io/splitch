import type { UserRole } from "@splitch/contracts";
import type { PanelAppSettings } from "@splitch/control-plane-sdk/panel-app-settings";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { appSettingsCapabilities } from "#lib/app-settings-capabilities";

vi.mock("#lib/control-plane-app-settings-functions", () => ({
  addControlPanelAppMember: vi.fn(),
  deleteControlPanelApp: vi.fn(),
  loadControlPanelAppSettings: vi.fn(),
  removeControlPanelAppMember: vi.fn(),
  updateControlPanelApp: vi.fn(),
  updateControlPanelAppMember: vi.fn(),
}));

vi.mock("#lib/control-plane-settings-functions", () => ({
  loadControlPanelSettings: vi.fn(),
  lockControlPanelClientKey: vi.fn(),
  provisionControlPanelApiKey: vi.fn(),
  revokeControlPanelApiKey: vi.fn(),
  updateControlPanelEnvironmentPolicy: vi.fn(),
}));

vi.mock("#lib/control-plane-exposure-status-functions", () => ({
  loadEnvironmentExposureStatus: vi.fn(),
}));

const { AppSettings } = await import("./app-settings");
const { AppMemberGrantForm, labelAppAccessCandidates } = await import("./app-member-grant-form");

function render(viewerRole: UserRole, overrides: Partial<PanelAppSettings> = {}) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <AppSettings
        env="prod"
        environmentId="environment_prod"
        environmentNames={["Dev", "Prod"]}
        orgSlug="acme"
        settings={{ ...settings, viewerRole, ...overrides }}
      />
    </QueryClientProvider>,
  );
}

describe("AppSettings", () => {
  it("gives an owner the rename form, the access controls, and the danger zone", () => {
    const html = render("owner");

    expect(html).toContain('id="app-settings-key"');
    expect(html).toContain('data-testid="app-danger-zone"');
    expect(html).toContain("Delete this App…");
  });

  it("renders a member payload without candidates and no grant form", () => {
    const renderMember = () => render("member", { candidates: undefined });

    expect(renderMember).not.toThrow();
    const html = renderMember();

    expect(html).toContain('data-testid="app-identity-read-only"');
    expect(html).not.toContain('id="app-settings-key"');
    expect(html).not.toContain('data-testid="app-danger-zone"');
    // Not a disabled form: a member sees what is true, not a control that looks broken.
    expect(html).not.toContain("disabled");
    expect(html).toContain('data-testid="app-grant-not-permitted"');
  });

  it("throws when a grant-capable viewer's payload omits candidates", () => {
    expect(() =>
      renderToStaticMarkup(
        <AppMemberGrantForm
          appId="app_checkout"
          capabilities={appSettingsCapabilities("admin")}
          onError={() => {}}
          onGranted={async () => {}}
        />,
      ),
    ).toThrow("App Settings omitted access candidates for a viewer who may grant access");
  });

  it("says the roster is withheld rather than exhausted for a grant-capable non-Org-admin", () => {
    const html = render("admin", { candidates: undefined, candidatesWithheld: true });

    expect(html).toContain('data-testid="app-grant-candidates-withheld"');
    expect(html).not.toContain('data-testid="app-grant-no-candidates"');
    expect(html).not.toContain('id="app-grant-person"');
  });

  it("withholds the danger zone from an admin, who may still rename", () => {
    const html = render("admin");

    expect(html).toContain('id="app-settings-key"');
    expect(html).not.toContain('data-testid="app-danger-zone"');
  });

  it("offers setup instructions while the Environment awaits its first data", () => {
    const html = render("owner");

    // Queries never resolve in a static render, so the card shows its loading
    // shape; the point here is that Settings surfaces setup at all.
    expect(html).toContain('data-testid="app-setup-card"');
    expect(html).toContain("Loading your Client Key");
  });

  it("shows the App-level Variant catalog read-only, with values as written", () => {
    const html = render("owner");

    expect(html).toContain("Checkout redesign");
    expect(html).toContain("{&quot;layout&quot;:&quot;wide&quot;}");
    expect(html).toContain("off");
  });

  it("says the default Variant is missing rather than silently picking one", () => {
    const html = render("owner", {
      flags: {
        ...settings.flags,
        items: settings.flags.items.map((flag) => ({ ...flag, defaultVariantName: null })),
      },
    });

    expect(html).toContain('data-testid="flag-default-unresolved"');
  });

  it("says so when the Flag catalog was truncated by the read limit", () => {
    const html = render("owner", {
      flags: { ...settings.flags, readTruncated: true },
    });

    expect(html).toContain("200");
  });

  it("gives same-role candidates without email distinct labels without exposing user ids", () => {
    const labeled = labelAppAccessCandidates([
      { userId: "user_unresolved_a", email: null, orgRole: "member" },
      { userId: "user_unresolved_b", email: null, orgRole: "member" },
    ]);

    expect(labeled.map(({ label }) => label)).toEqual([
      "Email not available yet (Organization Member 1 of 2)",
      "Email not available yet (Organization Member 2 of 2)",
    ]);
    expect(labeled.map(({ label }) => label).join(" ")).not.toContain("user_unresolved");
  });
});

const settings: PanelAppSettings = {
  app: {
    id: "app_checkout",
    organizationId: "org_acme",
    name: "Checkout API",
    key: "checkout-api",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  viewerRole: "owner",
  members: [
    {
      appId: "app_checkout",
      userId: "user_owner",
      email: "owner@acme.test",
      role: "owner",
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    {
      appId: "app_checkout",
      userId: "user_member",
      email: null,
      role: "member",
      createdAt: "2026-08-02T00:00:00.000Z",
    },
  ],
  candidates: [{ userId: "user_candidate", email: "candidate@acme.test", orgRole: "member" }],
  flags: {
    items: [
      {
        id: "flag_checkout",
        key: "checkout-redesign",
        name: "Checkout redesign",
        variants: [
          { id: "var_off", name: "off", value: "false" },
          { id: "var_on", name: "on", value: '{"layout":"wide"}' },
        ],
        defaultVariantName: "off",
      },
    ],
    readTruncated: false,
    readLimit: 200,
  },
};
