import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MutationErrorSurface } from "#lib/api";
import { ApprovalRefusalNotice } from "./approval-refusal-notice";

/**
 * The `RUN_FROZEN` arm used to be dead code: the Flag Configuration routes never
 * declared the code, so no forced write could reach it. Replacing the case labels
 * with an unreachable sentinel left the whole suite green, which is what a review
 * gate calls decoration. Now the Worker refuses a Flag Configuration write under a
 * live Run, this arm is on the real path, and this file is what kills that mutant.
 */
describe("ApprovalRefusalNotice", () => {
  it("renders a Run freeze as itself, with a remedy the operator can perform", () => {
    const html = renderToStaticMarkup(
      <ApprovalRefusalNotice
        error={surface(
          "RUN_FROZEN",
          "running Run run_live owns this Flag Configuration field; end it to change this",
        )}
      />,
    );

    expect(html).toContain('data-refusal-code="RUN_FROZEN"');
    // The Run is named, so the operator does not have to go hunting for what
    // stopped them (ADR-0036).
    expect(html).toContain("run_live");
    expect(html).toContain('data-refusal-remedy="true"');
    expect(html).toContain("A running Experiment owns this field. End its Run before changing it");
    expect(html).not.toContain("not one this screen expects");
  });

  it("gives a decision lock the same remedy, because the same action clears it", () => {
    const html = renderToStaticMarkup(
      <ApprovalRefusalNotice error={surface("DECISION_LOCKED", "decision family is locked")} />,
    );

    expect(html).toContain("A running Experiment owns this field. End its Run before changing it");
  });

  /**
   * The honest fallback. A screen that invented a remedy for a code it does not
   * know would send the operator somewhere useless.
   */
  it("admits an unexpected refusal rather than inventing a remedy", () => {
    const html = renderToStaticMarkup(
      <ApprovalRefusalNotice error={surface("INTERNAL_SERVER_ERROR", "boom")} />,
    );

    expect(html).toContain("This refusal is not one this screen expects");
  });
});

function surface(code: string, message: string): MutationErrorSurface {
  return { kind: "tier", code, message, fields: [] } as unknown as MutationErrorSurface;
}
