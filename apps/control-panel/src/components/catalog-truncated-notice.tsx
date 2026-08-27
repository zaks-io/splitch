import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";

/**
 * A bounded catalog page is showing a head of the list, and this says so.
 * Reloading returns the same page; the CLI and MCP read the same cap. The
 * notice states the bound and stops there (ADR-0036).
 */
export function CatalogTruncatedNotice({
  nounPlural,
  scopeNoun,
  readLimit,
  shownCount,
  testId,
}: {
  nounPlural: string;
  scopeNoun: string;
  readLimit: number;
  shownCount: number;
  testId: string;
}) {
  return (
    <Alert data-testid={testId}>
      <AlertTitle>
        More than {readLimit} {nounPlural} in this {scopeNoun}
      </AlertTitle>
      <AlertDescription>
        This {scopeNoun} has more {nounPlural} than the {readLimit} this screen reads at once. The{" "}
        {shownCount} below are not all of them.
      </AlertDescription>
    </Alert>
  );
}
