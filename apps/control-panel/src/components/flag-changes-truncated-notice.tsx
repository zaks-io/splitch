import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { parityHint } from "#lib/parity-hints";
import { ParityNote } from "./parity-note";

/**
 * The Overview's scan of changed Flag Configuration is capped, and this says so.
 *
 * The cap exists because a per-request read whose cost tracks how many Flags an
 * App has accumulated is a self-inflicted denial of service. But a capped list
 * rendered as if it were the whole list is the "quiet because unknown" shape
 * ADR-0036 forbids: an operator would read this card as the complete set of
 * recent changes and conclude that anything absent from it did not change.
 *
 * The remedy is deliberately NOT "reload" — the ceiling is not transient and a
 * refresh returns the same page. The Flag surfaces answer the whole question, so
 * that is what is named here, derived from the shipped route registry rather than
 * typed out, so a command the skins do not answer to cannot render.
 */
export function FlagChangesTruncatedNotice({
  readLimit,
  windowDays,
}: {
  readLimit: number;
  windowDays: number;
}) {
  return (
    <Alert data-testid="flag-changes-truncated">
      <AlertTitle>More than {readLimit} Flag Configurations changed</AlertTitle>
      <AlertDescription>
        This Environment had more than {readLimit} Flag Configuration changes in the last{" "}
        {windowDays} days, which is more than the Overview reads at once. The changes below are the
        most recent ones, not all of them. To see every Flag and its current state:{" "}
        <ParityNote hint={parityHint("flags_list")} />
      </AlertDescription>
    </Alert>
  );
}
