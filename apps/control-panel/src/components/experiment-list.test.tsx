import type { PanelExperimentListItem } from "@splitch/control-plane-sdk/panel-experiments";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExperimentList } from "./experiment-list";

const items: PanelExperimentListItem[] = [
  experiment("exp_draft", "Draft Checkout", "draft", null),
  experiment("exp_ended", "Ended Checkout", "ended", null),
  experiment("exp_clear", "Live Checkout", "running", {
    significanceReached: false,
    srmFiring: false,
    guardrailBreached: false,
  }),
  experiment("exp_significant", "Significant Checkout", "running", {
    significanceReached: true,
    srmFiring: false,
    guardrailBreached: false,
  }),
  experiment("exp_srm", "SRM Checkout", "running", {
    significanceReached: false,
    srmFiring: true,
    guardrailBreached: false,
  }),
  experiment("exp_guardrail", "Guardrail Checkout", "running", {
    significanceReached: false,
    srmFiring: false,
    guardrailBreached: true,
  }),
];

describe("ExperimentList", () => {
  it("renders lifecycle, controlled Flag, exact health states, and detail links", () => {
    const html = renderToStaticMarkup(
      <ExperimentList items={items} scopeHref="/acme/checkout/dev" />,
    );

    expect(html).toContain("Draft");
    expect(html).toContain("Running");
    expect(html).toContain("Ended");
    expect(html).toContain("Checkout Flag");
    expect(html).toContain("Collecting data");
    expect(html).toContain("Significance reached");
    expect(html).toContain("SRM firing");
    expect(html).toContain("Guardrail breached");
    expect(html).toContain('href="/acme/checkout/dev/experiments/exp_significant"');
  });

  it("routes a never-started draft into the guided flow and a former draft to its detail", () => {
    const neverStarted = experiment("exp_new", "New Checkout", "draft", null);
    const formerDraft = { ...experiment("exp_old", "Old Checkout", "draft", null), hasRuns: true };

    const html = renderToStaticMarkup(
      <ExperimentList items={[neverStarted, formerDraft]} scopeHref="/acme/checkout/dev" />,
    );

    expect(html).toContain('href="/acme/checkout/dev/experiments/exp_new/draft"');
    expect(html).toContain('href="/acme/checkout/dev/experiments/exp_old"');
    expect(html).not.toContain('href="/acme/checkout/dev/experiments/exp_old/draft"');
  });

  it("teaches the concept and provides one primary entry point when empty", () => {
    const html = renderToStaticMarkup(<ExperimentList items={[]} scopeHref="/acme/checkout/dev" />);

    expect(html).toContain("Create your first Experiment");
    expect(html).toContain("Start its first Run");
    expect(html).toContain("splitch experiments create");
    expect(html).toContain('href="/acme/checkout/dev/experiments/new"');
  });
});

function experiment(
  id: string,
  name: string,
  status: PanelExperimentListItem["status"],
  health: PanelExperimentListItem["health"],
): PanelExperimentListItem {
  return {
    id,
    name,
    status,
    flag: { id: "flag_checkout", name: "Checkout Flag" },
    liveRunId: status === "running" ? `run_${id}` : null,
    hasRuns: status !== "draft",
    health,
  };
}
