import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { parityHint } from "#lib/parity-hints";
import { ParityNote } from "./parity-note";

/**
 * The card is showing fewer Flag Configuration changes than actually happened,
 * and this says so.
 *
 * Two different bounds produce that gap and an operator needs to tell them
 * apart, but they compose into ONE notice, never two stacked ones. The display
 * cap is the common case: the Overview counted every change in the window and
 * renders only the newest few, so the notice can state the real total. The read
 * bound is the rarer, stricter case: the scan stopped at its ceiling, so the
 * count is a FLOOR and the notice says "more than" rather than naming a total it
 * never finished counting. The read bound wins when both fire, because a
 * precise-looking total that is really a floor is worse than no total at all.
 *
 * Either way the card is not the whole answer, and the remedy is deliberately
 * NOT "reload": neither bound is transient, so a refresh returns the same page
 * (ADR-0036). It IS the Flags screen, which reads the whole catalog and is one
 * click away. The sibling notice for Organizations names only the CLI and MCP
 * because a missing Organization is genuinely unreachable in the browser; a Flag
 * never is, so the reader's own skin is offered first and the parity hint
 * follows for the other two, derived from the shipped route registry rather than
 * typed out.
 */
export function FlagChangesTruncatedNotice({
  changedCount,
  readLimit,
  readTruncated,
  scopeHref,
  shownCount,
  windowDays,
}: {
  changedCount: number;
  readLimit: number;
  readTruncated: boolean;
  scopeHref: string;
  shownCount: number;
  windowDays: number;
}) {
  return (
    <Alert data-testid="flag-changes-truncated">
      <AlertTitle>
        {readTruncated
          ? `More than ${readLimit} Flag Configurations changed`
          : `${changedCount} Flag Configurations changed`}
      </AlertTitle>
      <AlertDescription>
        {readTruncated
          ? `More than ${readLimit} Flag Configurations changed in this Environment in the last ${windowDays} days, which is more than the Overview reads at once. The ${shownCount} below are the most recent of them, not all of them. `
          : `${changedCount} Flag Configurations changed in this Environment in the last ${windowDays} days. The ${shownCount} below are the most recent; the rest are not on this card. `}
        <a
          className="underline underline-offset-4 hover:no-underline"
          data-testid="flag-changes-truncated-link"
          href={`${scopeHref}/flags`}
        >
          See every Flag and its current state
        </a>
        , or: <ParityNote hint={parityHint("flags_list")} />
      </AlertDescription>
    </Alert>
  );
}
