import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EnvironmentScope } from "#lib/shared/loader-context";

vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ history: { push: vi.fn() } }) }));
vi.mock("#lib/settings/control-plane-settings-functions", () => ({
  updateControlPanelEnvironmentPolicy: vi.fn(),
}));
const { PanelSidebarEnvironments } = await import("#components/shell/panel-sidebar-environments");
const { TemporaryEnvironmentNotice } = await import(
  "#components/environments/temporary-environment-notice"
);
const { EnvironmentPolicyEditor } = await import(
  "#components/environments/environment-policy-editor"
);
const { TemporaryEnvironmentExperiments } = await import(
  "#components/experiments/temporary-environment-experiments"
);

const prod: EnvironmentScope = {
  environmentId: "env_prod",
  env: "prod",
  name: "Production",
  guarded: true,
  temporary: null,
};
const temporary: EnvironmentScope = {
  environmentId: "env_temporary",
  env: "pr-123",
  name: "Review copy",
  guarded: false,
  temporary: {
    expiresAt: "2026-10-20T12:00:00.000Z",
    syncedAt: "2026-10-18T12:00:00.000Z",
    syncedFromEnvironmentId: "env_prod",
  },
};

function switcher(environments: readonly EnvironmentScope[]) {
  return renderToStaticMarkup(
    <PanelSidebarEnvironments
      active="pr-123"
      appSlug="checkout"
      currentHref="/acme/checkout/pr-123/flags?state=active#rule"
      environments={environments}
      orgSlug="acme"
    />,
  );
}

describe("Temporary Environment controls", () => {
  it("groups permanent links before temporary links in keyboard focus order with expiry", () => {
    const html = switcher([temporary, prod]);
    expect(html).toContain('aria-label="Temporary Environments"');
    expect(html).toContain("20 Oct 2026, 12:00 UTC");
    expect(html).toContain('aria-current="page"');
    const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>/g)].map(([tag, href]) => ({
      tag,
      href,
    }));
    expect(links.map(({ href }) => href)).toEqual([
      "/acme/checkout/prod/flags?state=active#rule",
      "/acme/checkout/pr-123/flags?state=active#rule",
    ]);
    expect(links.every(({ tag }) => !tag.includes('tabindex="-1"'))).toBe(true);
    expect(html).not.toContain("env_temporary");
    expect(html).not.toContain("env_prod");
  });

  it("omits the temporary group when there are none", () => {
    expect(switcher([prod])).not.toContain("Temporary Environments");
  });

  it("shows expiry and the named Sync source without displaying canonical IDs", () => {
    const html = renderToStaticMarkup(
      <TemporaryEnvironmentNotice environment={temporary} environments={[temporary, prod]} />,
    );
    expect(html).toContain("Temporary Environment");
    expect(html).toContain('dateTime="2026-10-20T12:00:00.000Z"');
    expect(html).toContain("Production");
    expect(html).not.toContain("env_prod");
    expect(
      renderToStaticMarkup(
        <TemporaryEnvironmentNotice environment={temporary} environments={[temporary]} />,
      ),
    ).toContain("Environment no longer available");
    expect(
      renderToStaticMarkup(<TemporaryEnvironmentNotice environment={prod} environments={[prod]} />),
    ).toBe("");
  });

  it("keeps Policy fields and Save Policy outside keyboard focus with the reason visible", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <EnvironmentPolicyEditor
          appId="app_checkout"
          environmentId="env_temporary"
          initialPolicy={{
            enabledState: "allow",
            targetingRolloutValue: "allow",
            variantAvailability: "allow",
            startExperimentRun: "allow",
          }}
          unavailableReason="Policy editing is unavailable because a Temporary Environment always allows all changes."
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("Temporary Environment always allows all changes");
    expect(html.match(/<fieldset disabled=""/g)).toHaveLength(4);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save Policy<\/button>/);
  });

  it("disables Experiment creation with a persistent reason and no creation link", () => {
    const html = renderToStaticMarkup(<TemporaryEnvironmentExperiments />);
    expect(html).toContain("Temporary Environment cannot host Experiments");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>New Experiment<\/button>/);
    expect(html).toContain('aria-describedby="temporary-experiments-reason"');
    expect(html).not.toContain("href=");
  });
});
