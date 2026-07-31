import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PromotionDependencyNudge } from "./promotion-dependency-nudge";

describe("Promotion dependency nudge copy", () => {
  it.each([
    ['Targeting Rule 1: plan eq "pro" → beta (25%)'],
    ["a Targeting Rule serving beta"],
  ])("renders the dependency reason as a sentence: %s", (reason) => {
    const html = renderToStaticMarkup(
      <PromotionDependencyNudge
        dependencies={[{ variantName: "beta", reason, remedy: "none", rowId: null }]}
        disabled={false}
        onApply={vi.fn()}
      />,
    );

    expect(html.replaceAll("&quot;", '"')).toContain(`Added because ${reason} needs it.`);
  });
});
