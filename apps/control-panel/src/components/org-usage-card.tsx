import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import { EmptyState } from "@splitch/ui/state/empty-state";
import { WidgetErrorState } from "@splitch/ui/state/widget-error-state";
import { OrgUsageBarList } from "#components/org-usage-bar-list";
import { formatEvaluations, formatUsageMonth, type OrgUsage } from "#lib/org-billing";

/**
 * Current-month Evaluation consumption: one headline number, then the ADR-0033
 * reporting dimensions underneath. The dimensions are one breakdown of that
 * number, not seven separate meters, which is why they share its scale.
 */
export function OrgUsageCard({ usage }: { usage: OrgUsage }) {
  if (usage.kind === "unavailable") {
    return (
      <Card data-usage-state="unavailable">
        <CardHeader>
          <CardTitle>Evaluations this month</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Never rendered as a zero month: an unread total that looks like no
              consumption would understate what this Organization has spent. */}
          <WidgetErrorState
            className="border-none bg-transparent p-0"
            description={`Usage could not be read: ${usage.message}`}
            title="Usage unavailable"
          />
        </CardContent>
      </Card>
    );
  }

  const month = formatUsageMonth(usage.period.month);

  return (
    <Card data-usage-state={usage.evaluations > 0 ? "populated" : "zero"}>
      <CardHeader>
        <CardTitle>Evaluations this month</CardTitle>
        <CardDescription>{month}, counted in UTC.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <p
          className="font-mono font-semibold text-4xl text-foreground tabular-nums"
          data-usage-total=""
        >
          {formatEvaluations(usage.evaluations)}
        </p>

        {usage.evaluations > 0 ? (
          <div className="grid gap-6 sm:grid-cols-2">
            {usage.dimensions.map((dimension) => (
              <OrgUsageBarList
                dimension={dimension}
                key={dimension.id}
                monthEvaluations={usage.evaluations}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            className="border-dashed bg-transparent"
            description={`No Evaluation has been served for this Organization in ${month}. The breakdown appears once your SDKs start evaluating Flags.`}
            title="Nothing evaluated yet"
          />
        )}
      </CardContent>
    </Card>
  );
}
