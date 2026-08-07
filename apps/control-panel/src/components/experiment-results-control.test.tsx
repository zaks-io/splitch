import type { FrozenControlIdentity } from "@splitch/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExperimentResults } from "./experiment-results";
import {
  controlDisagreementStats,
  resultsFixture,
  statsFixture,
} from "./experiment-results-test-fixtures";

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
};

const disagreement: FrozenControlIdentity = {
  state: "disagreement",
  variantId: "variant_control",
  variant: "control",
  analysisVariant: "legacy_checkout",
};

function unresolvableHtml() {
  const stats = statsFixture();
  return renderToStaticMarkup(
    <ExperimentResults results={resultsFixture(stats, { control: unresolvable })} />,
  );
}

describe("ExperimentResults with an unidentifiable Control", () => {
  it("names the missing Variant and what the Run did freeze", () => {
    const html = unresolvableHtml();

    expect(html).toContain("Control arm cannot be identified");
    expect(html).toContain("variant_from_a_later_edit");
    expect(html).toContain("control, treatment");
    expect(html).toContain('role="alert"');
  });

  it("keeps the numbers on the page and blocks only the decision", () => {
    const html = unresolvableHtml();

    expect(html).toContain("+6.4%");
    expect(html).toContain("<svg");
    expect(html).toContain('data-testid="ship-blocked"');
  });

  it("marks no arm as the baseline rather than guessing one", () => {
    const html = unresolvableHtml();

    expect(html).toContain("Baseline unidentified");
    expect(html).not.toContain("baseline, by definition");
    expect(html).not.toContain("0% lift by definition");
  });

  it("says the baseline is unidentified everywhere it would have named it", () => {
    const html = unresolvableHtml();

    expect(html).toContain("an unidentified Control");
    expect(html).not.toContain("against control,");
  });
});

describe("ExperimentResults with an Analysis Control disagreement", () => {
  function disagreementHtml() {
    return renderToStaticMarkup(
      <ExperimentResults
        results={resultsFixture(controlDisagreementStats(), { control: disagreement })}
      />,
    );
  }

  it("names both Controls while every measurement anchor names the Analysis Control", () => {
    const html = disagreementHtml();

    expect(html).toContain("Analysis Control disagrees with the Run");
    expect(html).toContain(
      'This Run&#x27;s frozen Control is <code class="font-mono text-foreground text-xs">control</code>, but the Run Snapshot measured lift against <code class="font-mono text-foreground text-xs">legacy_checkout</code>. No ship decision can be made until they agree.',
    );
    expect(html).toContain("Relative lift against legacy_checkout");
    expect(html).toContain(
      "Relative lift and confidence interval per arm, against legacy_checkout.",
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
    expect(html).toContain("Conclude and promote winner");
    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
  });
});

function metricRow(html: string, variant: string): string {
  const row = (html.match(/<tr[\s\S]*?<\/tr>/g) ?? []).find((candidate) =>
    candidate.includes(`>${variant}</td>`),
  );
  if (!row) throw new Error(`missing Metric result row for ${variant}`);
  return row;
}
