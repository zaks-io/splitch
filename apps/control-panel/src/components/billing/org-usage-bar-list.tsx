import { formatEvaluations, type UsageDimension, usageShare } from "#lib/billing/org-billing";

/**
 * One reporting dimension as a ranked bar list.
 *
 * A single magnitude series, so it is one hue and needs no legend — the card
 * title names it. Every bar is measured against the month's own total
 * (`usageShare`), never against the largest row on screen, so a row that is 3%
 * of the month looks like 3% in every dimension it appears in.
 */
export function OrgUsageBarList({
  dimension,
  monthEvaluations,
}: {
  dimension: UsageDimension;
  monthEvaluations: number;
}) {
  const hidden = dimension.totalRows - dimension.rows.length;

  return (
    <section
      aria-label={dimension.label}
      className="grid gap-3"
      data-usage-dimension={dimension.id}
    >
      <h3 className="font-medium text-foreground text-sm">{dimension.label}</h3>
      <ul className="grid gap-2">
        {dimension.rows.map((row) => {
          const share = usageShare(row.evaluations, monthEvaluations);
          return (
            <li className="grid gap-1" data-usage-row={row.key} key={row.key}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-foreground">{row.label}</span>
                <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
                  {formatEvaluations(row.evaluations)}
                </span>
              </div>
              <div
                aria-hidden="true"
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
                title={`${row.label}: ${formatEvaluations(row.evaluations)} Evaluations, ${sharePercent(share)} of the month`}
              >
                {/* No minimum width: a sliver of a percent draws as a sliver,
                    and the exact count is already on the row. */}
                <div
                  className="h-full rounded-full bg-[color:var(--chart-1)]"
                  style={{ width: `${share * 100}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <p className="text-muted-foreground text-xs">
          Showing the {dimension.rows.length} highest of {dimension.totalRows}.
        </p>
      ) : null}
    </section>
  );
}

function sharePercent(share: number): string {
  const percent = share * 100;
  return `${percent < 1 ? percent.toFixed(2) : percent.toFixed(1)}%`;
}
