import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const submit = vi.fn();
let switchProps: { onCheckedChange(next: boolean): void } | undefined;

vi.mock("#lib/use-flag-editing", () => ({
  useFlagEditing: () => ({
    state: { phase: "idle" },
    busy: false,
    submit,
    confirm: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock("@splitch/ui/components/switch", () => ({
  Switch: (props: { checked: boolean; onCheckedChange(next: boolean): void }) => {
    switchProps = props;
    return <button aria-pressed={props.checked} data-kill-switch-input="true" type="button" />;
  },
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children?: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const { FlagsMatrixCell } = await import("./flags-matrix-cell");
const definition = {
  id: "flag_1",
  key: "new-checkout",
  variantCount: 2,
  variantLabels: { var_off: "off", var_on: "on" },
};

describe("FlagsMatrixCell", () => {
  beforeEach(() => {
    submit.mockReset();
    switchProps = undefined;
  });

  it("renders a configured Flag and submits the kill-switch intent", () => {
    const html = renderToStaticMarkup(
      <FlagsMatrixCell
        appId="app_1"
        cell={{
          enabled: false,
          availableVariantCount: 2,
          availableVariantNames: ["control", "treatment"],
          rolloutPercentages: [25],
          controllingExperiment: { id: "exp_1", name: "Checkout" },
        }}
        definition={definition}
        detailHref="/acme/checkout/dev/flags/new-checkout"
        env="dev"
        environmentId="env_dev"
      />,
    );

    expect(html).toContain('data-matrix-cell="dev"');
    expect(html).toContain("25% rollout");
    expect(html).toContain('title="Checkout"');
    switchProps?.onCheckedChange(true);
    expect(submit).toHaveBeenCalledWith({
      kind: "config",
      summary: "Enable this Flag in this Environment",
      patch: { enabled: true },
    });
  });

  it("renders Configure without a switch when the Configuration is absent", () => {
    const html = renderToStaticMarkup(
      <FlagsMatrixCell
        appId="app_1"
        cell={null}
        definition={definition}
        detailHref="/acme/checkout/prod/flags/new-checkout"
        env="prod"
        environmentId="env_prod"
      />,
    );

    expect(html).toContain("Not configured");
    expect(html).toContain('href="/acme/checkout/prod/flags/new-checkout"');
    expect(html).not.toContain("data-kill-switch-input");
  });
});
