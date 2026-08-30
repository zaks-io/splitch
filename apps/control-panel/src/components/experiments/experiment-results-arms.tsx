import { armColor } from "#lib/experiments/arm-colors";

export const RESULTS_RAIL_GRID =
  "grid grid-cols-[1.125rem_minmax(0,1fr)] sm:grid-cols-[5.5rem_minmax(0,1fr)]";

export function ExperimentResultsArms({
  allocation,
  baseline,
  dedupedCounts,
  variantOrder,
}: {
  allocation: Record<string, number>;
  baseline: string;
  dedupedCounts: Record<string, number>;
  variantOrder: readonly string[];
}) {
  if (variantOrder.length === 0) throw new Error("Run has no frozen Variants");
  const total = variantOrder.reduce(
    (sum, variant) => sum + requiredCount(dedupedCounts, variant),
    0,
  );
  return (
    <section aria-labelledby="results-allocation-heading" className={RESULTS_RAIL_GRID}>
      <div className="relative hidden h-28 sm:block" aria-hidden="true">
        <Fork variantOrder={variantOrder} baseline={baseline} />
      </div>
      <div className="relative h-20 sm:hidden" aria-hidden="true">
        <span className="absolute top-0 bottom-0 left-1/2 border-border border-l-2" />
        <span className="absolute top-7 left-1/2 size-2 -translate-x-1/2 rounded-full border-2 border-border bg-background" />
      </div>

      <div className="pb-8 sm:pb-10">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-semibold text-foreground text-sm" id="results-allocation-heading">
            Allocation
          </h3>
          <p className="font-mono text-muted-foreground text-xs">
            {variantOrder.length} Variants · {total.toLocaleString("en-US")} deduped exposures
          </p>
        </div>
        <ul className="mt-3 grid gap-2">
          {variantOrder.map((variant) => {
            const color = armColor({ baseline, variant, variantOrder });
            const share = allocation[variant];
            if (share === undefined) {
              throw new Error(`Missing allocation for frozen Variant ${variant}`);
            }
            const count = requiredCount(dedupedCounts, variant);
            return (
              <li
                className="flex min-h-11 items-center gap-3 rounded-r-md border-l-[3px] bg-muted/50 py-2 pr-3 pl-4"
                key={variant}
                style={{ borderLeftColor: color }}
              >
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: color }}
                />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm sm:flex-none sm:basis-40">
                  {variant}
                </span>
                <span className="font-mono text-muted-foreground text-sm">{share}%</span>
                <span className="text-muted-foreground text-xs">
                  {variant === baseline ? "baseline" : "treatment"}
                </span>
                <span className="ml-auto font-mono text-foreground text-sm">
                  {count.toLocaleString("en-US")}
                </span>
                <span className="hidden font-mono text-muted-foreground text-xs sm:inline">
                  exposures
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

export function ExperimentResultsRails({
  baseline,
  variantOrder,
  flaggedVariant,
}: {
  baseline: string;
  variantOrder: readonly string[];
  flaggedVariant?: string;
}) {
  return (
    <div className="relative" aria-hidden="true">
      <div
        className="absolute inset-0 hidden sm:grid"
        style={{ gridTemplateColumns: `repeat(${variantOrder.length}, minmax(0, 1fr))` }}
      >
        {variantOrder.map((variant) => (
          <span
            className="mx-auto h-full border-l-2"
            key={variant}
            style={{
              borderLeftColor:
                variant === flaggedVariant
                  ? "var(--warning)"
                  : armColor({ baseline, variant, variantOrder }),
            }}
          />
        ))}
      </div>
      <span className="absolute inset-y-0 left-1/2 border-border border-l-2 sm:hidden" />
    </div>
  );
}

function Fork({ baseline, variantOrder }: { baseline: string; variantOrder: readonly string[] }) {
  const width = 88;
  const center = width / 2;
  return (
    <svg
      aria-hidden="true"
      className="block h-28 w-[5.5rem]"
      fill="none"
      viewBox={`0 0 ${width} 112`}
    >
      <path d={`M${center} 0 L${center} 30`} stroke="var(--border)" strokeWidth="2" />
      <circle
        cx={center}
        cy="34"
        fill="var(--background)"
        r="4"
        stroke="var(--border)"
        strokeWidth="2"
      />
      {variantOrder.map((variant, index) => {
        const x = ((index + 0.5) * width) / variantOrder.length;
        return (
          <path
            d={`M${center} 38 C${center} 68 ${x} 72 ${x} 112`}
            key={variant}
            stroke={armColor({ baseline, variant, variantOrder })}
            strokeWidth="2"
          />
        );
      })}
    </svg>
  );
}

function requiredCount(counts: Record<string, number>, variant: string): number {
  const count = counts[variant];
  if (count === undefined) throw new Error(`Missing deduped exposure count for Variant ${variant}`);
  return count;
}
