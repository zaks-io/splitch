import type { OverviewFlagConfigChange } from "@splitch/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OverviewFlagChangesCard } from "#components/overview/overview-flag-changes-card";

const SCOPE = "/acme/checkout/production";
const CHANGE: OverviewFlagConfigChange = {
  seq: 1,
  flagId: "flag_checkout",
  flagKey: "checkout",
  action: "updated",
  targetType: "flag_config",
  actorRef: null,
  actorVia: null,
  changedAt: "2026-07-19T10:00:00.000Z",
};

function render(recentlyChanged: OverviewFlagConfigChange[]) {
  return renderToStaticMarkup(
    <OverviewFlagChangesCard
      changedCount={recentlyChanged.length}
      readLimit={50}
      readTruncated={false}
      recentlyChanged={recentlyChanged}
      scopeHref={SCOPE}
      windowDays={7}
    />,
  );
}

describe("OverviewFlagChangesCard", () => {
  it("shows definition, deletion and Configuration events on the same Flag as separate changes", () => {
    const html = render([
      { ...CHANGE, seq: 3, action: "deleted", targetType: "flag" },
      { ...CHANGE, seq: 2 },
      { ...CHANGE, seq: 1, action: "created", targetType: "flag" },
    ]);

    expect(html.match(/data-overview-flag="checkout"/gu) ?? []).toHaveLength(3);
    expect(html.match(/href="\/acme\/checkout\/production\/flags"/gu) ?? []).toHaveLength(3);
    expect(html).not.toContain(`href="${SCOPE}/flags/checkout"`);
    for (const action of ["Created", "Updated", "Deleted"]) {
      expect(html).toContain(`>${action}<`);
    }
    expect(html).toContain('dateTime="2026-07-19T10:00:00.000Z"');
    expect(html).toContain("19 Jul 2026, 10:00 UTC");
    expect(html).not.toContain(">Enabled<");
    expect(html).not.toContain(">Disabled<");
    expect(html).not.toContain("Who made each change is not recorded yet");
  });

  it("sends a deleted Flag to the Flags screen instead of a missing detail page", () => {
    const html = render([{ ...CHANGE, action: "deleted", targetType: "flag" }]);

    expect(html).toContain(`href="${SCOPE}/flags"`);
    expect(html).not.toContain(`href="${SCOPE}/flags/checkout"`);
  });

  it("reports an empty event log without claiming no actor is recorded", () => {
    const html = render([]);

    expect(html).toContain("No Flag changes recorded in the last 7 days.");
    expect(html).toContain("Includes App-level changes and changes in this Environment.");
    expect(html).not.toContain('data-testid="flag-changes-truncated"');
  });
});
