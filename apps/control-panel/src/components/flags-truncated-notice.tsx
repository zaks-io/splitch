import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";

/**
 * The Flag table is showing a page of this App's catalog, and this says so.
 *
 * The catalog read is bounded, so an App past the ceiling gets the newest
 * `readLimit` Flags and nothing tells the operator that from the table itself —
 * a full page and a complete catalog of the same size look identical. Saying it
 * is the whole job of this notice.
 *
 * It deliberately offers NO remedy, unlike its sibling on the Overview. The
 * Overview's truncation has a wider view to point at; this one is the wider
 * view. Reloading returns the same page, and the CLI and MCP read this same
 * bounded endpoint, so naming any of them would be instructing a fix that does
 * not exist (ADR-0036). It states the bound and what the page therefore is, and
 * stops there.
 */
export function FlagsTruncatedNotice({
  readLimit,
  shownCount,
}: {
  readLimit: number;
  shownCount: number;
}) {
  return (
    <Alert data-testid="flags-truncated">
      <AlertTitle>More than {readLimit} Flags in this App</AlertTitle>
      <AlertDescription>
        This App has more Flags than the {readLimit} this screen reads at once. The {shownCount}{" "}
        below are the most recently created, not all of them.
      </AlertDescription>
    </Alert>
  );
}
