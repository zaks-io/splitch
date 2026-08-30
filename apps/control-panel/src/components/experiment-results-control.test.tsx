import type { FrozenControlIdentity } from "@splitch/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExperimentResults } from "./experiment-results";
import {
  controlDisagreementStats,
  resultsFixture,
  runFixture,
  statsWithAnalysisControl,
} from "./experiment-results-test-fixtures";
import { visibleText } from "./experiment-results-test-markup";

/**
 * What the tab does when the Run's frozen Control cannot be resolved.
 *
 * The failure has to be legible and specific. A page that quietly styled the
 * first arm as the baseline, or that dropped the numbers entirely, would each be
 * worse than saying which Variant is missing and refusing the decision.
 */

const unresolvable: FrozenControlIdentity = {
  state: "unresolvable",
  variantId: "variant_from_a_later_edit",
  reason: "absent_from_frozen_variant_set",
  frozenVariantNames: ["control", "treatment"],
  analysisVariant: "control",
};

const disagreement: FrozenControlIdentity = {
  state: "disagreement",
  variantId: "variant_control",
  variant: "control",
  analysisVariant: "legacy_checkout",
};

function unresolvableHtml() {
  const stats = statsWithAnalysisControl();
  return renderToStaticMarkup(
    <ExperimentResults
      run={runFixture()}
      results={resultsFixture(stats, { control: unresolvable })}
    />,
  );
}

describe("ExperimentResults with an unidentifiable Control", () => {
  it("explains the unresolved Control and styles the recorded diagnostic value", () => {
    const html = unresolvableHtml();

    expect(html).toContain("Control Variant cannot be identified");
    expect(html).toContain("it is absent from the Variant set this Run froze");
    expect(html).toContain("control, treatment");
    expect(html).toContain(
      '<code class="font-mono text-foreground text-xs">variant_from_a_later_edit</code>',
    );
    expect(html).not.toContain("absent_from_frozen_variant_set");
    expect(html).toContain('role="alert"');
    // SPL-189: the PR gate's only coverage of the icon that distinguishes this
    // card from a confirmed-SRM card, since that proof otherwise lives solely in
    // the weekly, presently-unbootable e2e suite.
    expect(html).toContain("lucide-circle-alert");
  });

  it("keeps the numbers on the page and blocks only the decision", () => {
    const html = unresolvableHtml();
    const text = visibleText(html);

    expect(html).toContain("+6.4%");
    expect(html).toContain("<svg");
    expect(html).toContain('data-testid="ship-blocked"');
    expect(text).toContain(
      "The Run Snapshot written to the analytics store at Start recorded control as the Analysis Control. Every lift below is measured against that Variant.",
    );
    expect(text).toContain(
      "What the Snapshot cannot establish is the Run's own frozen Control, so the ship decision is blocked.",
    );
  });

  it("names and renders the Analysis Control as the baseline while blocking the decision", () => {
    const html = unresolvableHtml();
    const text = visibleText(html);
    const analysisControlRow = metricRow(html, "control");
    const controlClaims = {
      neverRecorded: text.includes("baseline this Run never recorded"),
      baselineBadge: analysisControlRow.includes(">Baseline</"),
    };

    expect(text).toContain(
      "Relative lift against control, with an always-valid confidence sequence.",
    );
    expect(text).toContain("Relative lift and confidence interval per Variant, against control.");
    expect(text).toContain("relative lift vs control (%)");
    expect(html).toContain('aria-label="Relative lift with confidence intervals against control"');
    expect(text).not.toContain("unidentified");
    expect(controlClaims).toEqual({
      neverRecorded: false,
      baselineBadge: true,
    });
    expect(html).toContain(
      "control · checkout_conversion: baseline, 0% lift by definition, n=12530",
    );
    expect(html).not.toContain(
      "control · checkout_conversion: not estimable lift, [−∞, +∞], n=12530",
    );
    expect(html).toContain("Baseline (control) at zero lift by definition");
    expect(analysisControlRow).toContain("0.0%");
    expect(analysisControlRow).toContain("baseline, by definition");
    expect(analysisControlRow).toContain(">Baseline</");
    expect(analysisControlRow).not.toContain("not estimable");
    expect(analysisControlRow).not.toContain("[−∞, +∞]");
    expect(analysisControlRow).not.toContain("Not decision-valid");
    expect(analysisControlRow).not.toContain(">1.0</td>");
  });
});

describe("ExperimentResults with an Analysis Control disagreement", () => {
  function disagreementHtml() {
    return renderToStaticMarkup(
      <ExperimentResults
        run={runFixture({
          allocation: { legacy_checkout: 50, control: 50 },
          variantsJson: JSON.stringify([
            { id: "variant_legacy", name: "legacy_checkout", value: false },
            { id: "variant_control", name: "control", value: true },
          ]),
        })}
        results={resultsFixture(controlDisagreementStats(), { control: disagreement })}
      />,
    );
  }

  it("names both Controls while every measurement anchor names the Analysis Control", () => {
    const html = disagreementHtml();

    expect(html).toContain("Analysis Control disagrees with the Run");
    // SPL-189: pins this branch's icon too — without it, swapping in
    // AlertTriangleIcon here (the confirmed-SRM icon) passes every other
    // assertion, which is exactly the severity-swap defect this PR gates.
    expect(html).toContain("lucide-circle-alert");
    expect(html).toContain(
      'This Run froze <code class="font-mono text-foreground text-xs">control</code> as its Control, but the Run Snapshot written to the analytics store at Start recorded <code class="font-mono text-foreground text-xs">legacy_checkout</code>. Both are written at Start and should match. Because they do not, every lift below is measured against <code class="font-mono text-foreground text-xs">legacy_checkout</code> and not against the Run&#x27;s own Control.',
    );
    expect(html).toContain(
      "The Run Snapshot cannot be rewritten, so this Run cannot be corrected. Start a new Run to get a Control that agrees across both stores.",
    );
    expect(html).toContain("The numbers below remain visible for diagnosis.");
    expect(html).toContain("Relative lift against legacy_checkout");
    expect(html).toContain(
      "Relative lift and confidence interval per Variant, against legacy_checkout.",
    );
    expect(html).toContain(
      'aria-label="Relative lift with confidence intervals against legacy_checkout"',
    );
    expect(html).toContain("relative lift vs legacy_checkout (%)");
    expect(html).toContain("Baseline (legacy_checkout) at zero lift by definition");
    expect(html).not.toContain("Relative lift against control");
    expect(html).not.toContain("relative lift vs control (%)");
    expect(html).not.toContain("Tinybird");
    expect(html).not.toContain("control_variant");
    expect(html).toContain('role="alert"');
  });

  it("anchors computed statistics on the Analysis Control without fabricating the frozen arm", () => {
    const html = disagreementHtml();
    const analysisControlRow = metricRow(html, "legacy_checkout");
    const frozenControlRow = metricRow(html, "control");

    expect(analysisControlRow).toContain("0.0%");
    expect(analysisControlRow).toContain("baseline, by definition");
    expect(analysisControlRow).toContain("Baseline");
    expect(html).toContain(
      "legacy_checkout · checkout_conversion: baseline, 0% lift by definition",
    );

    expect(frozenControlRow).toContain("+6.4%");
    expect(frozenControlRow).toContain("[+1.9, +11.2]");
    expect(frozenControlRow).not.toContain("0.0%");
    expect(frozenControlRow).not.toContain("baseline, by definition");
    expect(html).toContain("control · checkout_conversion: +6.4% lift, [+1.9, +11.2]");
  });

  it("keeps the numbers visible and blocks conclude or Promote with the failing check named", () => {
    const html = disagreementHtml();

    expect(html).toContain("+6.4%");
    expect(html).toContain("<svg");
    expect(html).toContain('data-testid="ship-blocked"');
    expect(html).toContain("Analysis Control disagrees with the Run");
    expect(html).toContain("Conclude Run");
    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
  });
});

function metricRow(html: string, variant: string): string {
  const row = (html.match(/<tr[\s\S]*?<\/tr>/g) ?? []).find(
    (candidate) =>
      candidate.includes(`>${variant}</td>`) && candidate.includes("checkout_conversion"),
  );
  if (!row) throw new Error(`missing Metric result row for ${variant}`);
  return row;
}
