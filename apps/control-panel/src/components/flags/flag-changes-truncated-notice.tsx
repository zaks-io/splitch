import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { ParityNote } from "#components/connect/parity-note";
import { parityHint } from "#lib/connect/parity-hints";

/** Report the observed event count, giving the read bound precedence over the display cap. */
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
          ? `More than ${readLimit} Flag changes recorded`
          : `${changedCount} Flag changes recorded`}
      </AlertTitle>
      <AlertDescription>
        {readTruncated
          ? `More than ${readLimit} Flag changes recorded for this Environment or the App in the last ${windowDays} days, which is more than the Overview reads at once. The ${shownCount} below are the most recent of them, not all of them. `
          : `${changedCount} Flag changes recorded for this Environment or the App in the last ${windowDays} days. The ${shownCount} below are the most recent; the rest are not on this card. `}
        <a
          className="underline underline-offset-4 hover:no-underline"
          data-testid="flag-changes-truncated-link"
          href={`${scopeHref}/flags`}
        >
          Open the Flags screen for this App
        </a>
        , or: <ParityNote hint={parityHint("flag_changes_list")} />
      </AlertDescription>
    </Alert>
  );
}
