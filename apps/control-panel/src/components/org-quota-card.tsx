import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";

/**
 * What the month's count is measured against — today, nothing.
 *
 * V1 billing is one Organization-scoped Evaluation allowance (ADR-0033), but the
 * allowance is not published and the data plane enforces no limit yet. So this
 * card states that instead of showing a quota state: a panel claiming Active,
 * Grace, or Exhausted would be describing enforcement that does not run.
 */
export function OrgQuotaCard() {
  return (
    <Card data-quota-state="deferred">
      <CardHeader>
        <CardTitle>Allowance and limits</CardTitle>
        <CardDescription>What this month&rsquo;s count is measured against.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm leading-6">
        <p className="text-foreground">
          This Organization has no monthly Evaluation allowance set, so the count above is a total,
          not a balance.
        </p>
        <p className="text-muted-foreground">
          No limit is enforced. Every valid Evaluation is served, and none is refused because of
          usage. When an allowance applies to this Organization, this panel will state the number
          and what happens as you approach it.
        </p>
      </CardContent>
    </Card>
  );
}
