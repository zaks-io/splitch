import { describe, expect, it } from "vitest";
import { changes, renderOverview as render, SCOPE_HREF } from "./overview-page-test-fixtures";

const ONE_CHANGE = changes(1);

/**
 * Two bounds sit between what changed in the Environment and what this card
 * shows: the read bound (the Overview never looked at them all) and the display
 * cap (it looked, and renders only the newest few). Either makes a full-looking
 * card a partial one, and the card owes the operator exactly one notice saying
 * which.
 */
describe("Overview Flag Configuration read bound", () => {
  it("says the scan was capped instead of passing off a partial list", () => {
    const html = render({
      flagConfiguration: {
        windowDays: 7,
        changedCount: 50,
        readTruncated: true,
        readLimit: 50,
        recentlyChanged: ONE_CHANGE,
      },
    });

    expect(html).toContain('data-testid="flag-changes-truncated"');
    expect(html).toContain("More than 50 Flag Configurations changed");
    // The remedy is a surface that answers the whole question, never "reload":
    // the ceiling is not transient, so a retry returns the same page (ADR-0036).
    expect(html).not.toContain("Refresh");
    // And the reader is in a browser, where the whole catalog is one click away.
    // Naming only the CLI and MCP would send them to a terminal for a screen this
    // app already ships.
    expect(html).toContain('data-testid="flag-changes-truncated-link"');
    expect(html).toContain(`href="${SCOPE_HREF}/flags"`);
  });

  it("never renders the calm state while the scan is truncated", () => {
    // Truncated means the list is KNOWN to be incomplete, so an empty one is not
    // evidence of quiet -- and calm would render the truncation notice away.
    const html = render({
      flagConfiguration: {
        windowDays: 7,
        changedCount: 0,
        readTruncated: true,
        readLimit: 50,
        recentlyChanged: [],
      },
    });

    expect(html).not.toContain("Nothing needs your attention");
    expect(html).toContain('data-testid="flag-changes-truncated"');
    // "More than 50 changed" and "nothing changed" cannot both be true, so the
    // empty line yields to the notice rather than sitting under it.
    expect(html).not.toContain("No Flag Configuration changed in the last");
  });

  it("does not claim truncation when the scan came back under the ceiling", () => {
    // Rendered with a change present, so the card itself is on the page and the
    // absent notice is a real finding rather than a card that never rendered.
    const html = render({
      flagConfiguration: {
        windowDays: 7,
        changedCount: 1,
        readTruncated: false,
        readLimit: 50,
        recentlyChanged: ONE_CHANGE,
      },
    });

    expect(html).toContain('data-overview-card="flag-changes"');
    expect(html).not.toContain('data-testid="flag-changes-truncated"');
  });
});

describe("Overview Flag Configuration display cap", () => {
  it("says how many changed when more changed than the card shows", () => {
    const html = render({
      flagConfiguration: {
        windowDays: 7,
        changedCount: 12,
        readTruncated: false,
        readLimit: 50,
        recentlyChanged: changes(5),
      },
    });

    expect(html).toContain('data-testid="flag-changes-truncated"');
    // Not hedged: the scan completed, so the total is known exactly, and "more
    // than 5" would understate what the operator is not seeing.
    expect(html).toContain("12 Flag Configurations changed");
    expect(html).not.toContain("More than");
    expect(html).toContain("The 5 below are the most recent");
    // The cap is not transient either, so the remedy is still the Flags screen.
    expect(html).not.toContain("Refresh");
    expect(html).toContain('data-testid="flag-changes-truncated-link"');
    expect(html).toContain(`href="${SCOPE_HREF}/flags"`);
  });

  it("renders no notice when the card shows every change it counted", () => {
    const html = render({
      flagConfiguration: {
        windowDays: 7,
        changedCount: 3,
        readTruncated: false,
        readLimit: 50,
        recentlyChanged: changes(3),
      },
    });

    expect(html).toContain('data-overview-card="flag-changes"');
    expect(html).not.toContain('data-testid="flag-changes-truncated"');
  });

  it("states one bound, not two, when the read ceiling and the display cap both bind", () => {
    // The only case where they compete. The count is itself capped by the read
    // limit, so rendering it as an exact total would be a precise-looking lie:
    // the stricter bound wins and the notice reports a floor.
    const html = render({
      flagConfiguration: {
        windowDays: 7,
        changedCount: 50,
        readTruncated: true,
        readLimit: 50,
        recentlyChanged: changes(5),
      },
    });

    expect((html.match(/data-testid="flag-changes-truncated"/gu) ?? []).length).toBe(1);
    expect(html).toContain("More than 50 Flag Configurations changed");
    expect(html).not.toContain("the rest are not on this card");
  });
});
