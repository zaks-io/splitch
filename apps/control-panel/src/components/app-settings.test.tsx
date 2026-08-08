import type { UserRole } from "@splitch/contracts";
import type { PanelAppSettings } from "@splitch/control-plane-sdk/panel-app-settings";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("#lib/control-plane-app-settings-functions", () => ({
  addControlPanelAppMember: vi.fn(),
  deleteControlPanelApp: vi.fn(),
  loadControlPanelAppSettings: vi.fn(),
  removeControlPanelAppMember: vi.fn(),
  updateControlPanelApp: vi.fn(),
  updateControlPanelAppMember: vi.fn(),
}));

const { AppSettings } = await import("./app-settings");

function render(viewerRole: UserRole, overrides: Partial<PanelAppSettings> = {}) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <AppSettings
        env="prod"
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

  it("gives a member the same facts as plain text, and no danger zone", () => {
    const html = render("member");

    expect(html).toContain('data-testid="app-identity-read-only"');
    expect(html).not.toContain('id="app-settings-key"');
    expect(html).not.toContain('data-testid="app-danger-zone"');
    // Not a disabled form: a member sees what is true, not a control that looks broken.
    expect(html).not.toContain("disabled");
    expect(html).toContain('data-testid="app-grant-not-permitted"');
  });

  it("withholds the danger zone from an admin, who may still rename", () => {
    const html = render("admin");

    expect(html).toContain('id="app-settings-key"');
    expect(html).not.toContain('data-testid="app-danger-zone"');
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
