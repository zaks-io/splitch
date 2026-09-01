import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FlagsEmptyState } from "#components/flags/flags-empty-state";
import { FlagsPage } from "#components/flags/flags-page";
import { FlagsTable } from "#components/flags/flags-table";
import { FlagsTruncatedNotice } from "#components/flags/flags-truncated-notice";
import type { FlagsPageItem } from "#lib/flags/flags-page-data";

const submit = vi.fn();
let switchProps: Array<{ checked: boolean; onCheckedChange(next: boolean): void }> = [];

vi.mock("#lib/flags/use-flag-editing", () => ({
  useFlagEditing: () => ({
    state: { phase: "idle" },
    busy: false,
    submit,
    confirm: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock("@splitch/ui/components/switch", () => ({
  Switch: (props: {
    "aria-label": string;
    checked: boolean;
    onCheckedChange(next: boolean): void;
  }) => {
    switchProps.push(props);
    return (
      <button
        aria-checked={props.checked}
        aria-label={props["aria-label"]}
        data-kill-switch-input="true"
        role="switch"
        type="button"
      />
    );
  },
}));
vi.mock("#components/flags/create-flag-dialog", () => ({
  CreateFlagDialog: () => <button type="button">Create Flag</button>,
}));
vi.mock("#components/environments/environment-segmented-control", () => ({
  EnvironmentSegmentedControl: () => <nav data-environment-segmented />,
}));

describe("Flags page", () => {
  beforeEach(() => {
    submit.mockReset();
    switchProps = [];
  });

  it("renders checked and unchecked inline switches with Environment-specific labels", () => {
    const html = renderTable([
      configuredItem("enabled-flag", true),
      configuredItem("off-flag", false),
    ]);

    expect(html).toContain('aria-label="serving enabled-flag in dev"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="serving off-flag in dev"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("25% rollout");
    expect(html).toContain("2 of 2");
    expect(html).toContain('href="/acme-labs/checkout-api/dev/flags/enabled-flag"');

    switchProps[0]?.onCheckedChange(false);
    expect(submit).toHaveBeenCalledWith({
      kind: "config",
      summary: "Turn this Flag off immediately",
      patch: { enabled: false },
    });
  });

  it("renders Not configured and no switch when the Configuration is absent", () => {
    const item = configuredItem("new-flag", false);
    item.configuration = null;
    const html = renderTable([item]);

    expect(html).toContain('data-flag-enabled="unconfigured"');
    expect(html).toContain("Not configured");
    expect(html).not.toContain("data-kill-switch-input");
  });

  it("tints the header and names a guarded Environment beside the title", () => {
    const html = renderFlagsPage(true, "production");

    expect(html).toContain("bg-warning-muted/40");
    expect(html).toContain('data-active-environment="production"');
    expect(html).toContain(">production</span>");
    expect(html).toContain("data-environment-segmented");
  });

  it("names an allowing Environment without guard treatment", () => {
    const html = renderFlagsPage(false, "dev");

    expect(html).not.toContain("bg-warning-muted/40");
    expect(html).toContain('data-active-environment="dev"');
    expect(html).toContain("data-environment-segmented");
  });

  it("teaches the Flag concept and the CLI/MCP equivalents in the empty state", () => {
    const html = renderToStaticMarkup(
      <FlagsEmptyState
        appId="app_checkout"
        environmentId="env_dev"
        settingsHref="/acme-labs/checkout-api/dev/settings"
      />,
    );

    expect(html).toContain("Create your first Flag");
    expect(html).toContain("A Flag is a named toggle with Variants.");
    expect(html).toContain("splitch flags create");
    expect(html).toContain("flags_create");
  });

  it("says the table is a page of the catalog without promising an unavailable remedy", () => {
    const html = renderToStaticMarkup(<FlagsTruncatedNotice readLimit={200} shownCount={200} />);

    expect(html).toContain("More than 200 Flags in this App");
    expect(html).toContain("The 200 below are the most recently created, not all of them.");
    expect(html).not.toContain("Reload");
    expect(html).not.toContain("splitch flags");
  });
});

function configuredItem(key: string, enabled: boolean): FlagsPageItem {
  return {
    definition: {
      id: `flag_${key}`,
      key,
      variantCount: 2,
      variantLabels: { var_disabled: "disabled", var_enabled: "enabled" },
    },
    configuration: {
      enabled,
      availableVariantCount: 2,
      availableVariantNames: ["disabled", "enabled"],
      rolloutPercentages: [25],
      controllingExperiment: null,
    },
  };
}

function renderTable(items: FlagsPageItem[]): string {
  return renderToStaticMarkup(
    <FlagsTable
      appId="app_checkout"
      env="dev"
      environmentId="env_dev"
      items={items}
      scopeHref="/acme-labs/checkout-api/dev"
    />,
  );
}

function renderFlagsPage(guarded: boolean, env: string): string {
  return renderToStaticMarkup(
    <FlagsPage
      appId="app_checkout"
      appSlug="checkout-api"
      env={env}
      environmentId={`env_${env}`}
      environments={[{ env, guarded }]}
      guarded={guarded}
      items={[configuredItem("new-checkout", true)]}
      orgSlug="acme-labs"
      readLimit={200}
      readTruncated={false}
      scopeHref={`/acme-labs/checkout-api/${env}`}
    />,
  );
}
