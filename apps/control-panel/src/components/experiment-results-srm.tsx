import type { ExperimentSrmDiagnostics, SrmSignal, StatsOutput } from "@splitch/contracts";
import { formatPValue } from "@splitch/contracts";

/**
 * Graduated Sample Ratio Mismatch reporting.
 *
 * Two tiers, because a p-value in the 0.001–0.01 band is noisy enough to watch
 * and not noisy enough to condemn. Neither tier ever hides the result numbers:
 * this block sits beside the lift plot, never in front of it.
 */

export function ExperimentResultsSrm({
  srm,
  stats,
}: {
  srm: ExperimentSrmDiagnostics;
  stats: StatsOutput;
}) {
  const worst = worstTier(srm);
  return (
    <section
      aria-labelledby="results-srm-heading"
      className={`rounded-lg border p-5 shadow-sm ${surfaceFor(worst)}`}
      data-srm-tier={worst}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold text-base text-foreground" id="results-srm-heading">
          Assignment balance
        </h3>
        <span className="font-mono text-muted-foreground text-xs uppercase tracking-[0.16em]">
          {tierLabel(worst)}
        </span>
      </div>
      <p className="mt-1 max-w-prose text-muted-foreground text-sm">{tierCopy(worst)}</p>

      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        <SignalStat label="Exposure SRM" signal={srm.exposure} />
        <SignalStat label="Activated SRM" signal={srm.activated} />
        <SignalStat label="Activation balance" signal={srm.activationBalance} />
      </dl>

      <DeviationTable signal={srm.exposure} />

      <div className="mt-4 grid gap-1 border-border border-t pt-3 text-muted-foreground text-xs">
        <p>
          Exposures {countLine(stats.health.exposure_counts)} · after dedupe{" "}
          {countLine(stats.health.deduped_counts)}
        </p>
        <p>
          A mismatch is a data-quality signal, not a result. It is reported from the same Run
          snapshot as the numbers beside it; splitch does not keep a p-value history, so persistence
          across snapshots cannot be shown here yet.
        </p>
      </div>

      <DimensionCuts stats={stats} />
    </section>
  );
}

function SignalStat({
  label,
  signal,
}: {
  label: string;
  signal: Pick<SrmSignal, "tier" | "pValue"> | null;
}) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-mono text-foreground text-sm">
        {signal === null ? "not measured" : `p = ${formatP(signal.pValue)}`}
      </dd>
      <dd className="text-muted-foreground text-xs">
        {signal === null ? "no activation Metric on this Run" : tierLabel(signal.tier)}
      </dd>
    </div>
  );
}

function DeviationTable({ signal }: { signal: SrmSignal }) {
  if (signal.deviations.length === 0) return null;
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[24rem] text-sm">
        <caption className="sr-only">Observed versus expected exposures per Variant</caption>
        <thead>
          <tr className="text-muted-foreground text-xs">
            <th className="py-1 text-left font-medium">Variant</th>
            <th className="py-1 text-right font-medium">Observed</th>
            <th className="py-1 text-right font-medium">Expected</th>
            <th className="py-1 text-right font-medium">Delta</th>
          </tr>
        </thead>
        <tbody>
          {signal.deviations.map((deviation) => (
            <tr className="border-border border-t" key={deviation.variant}>
              <td className="py-1.5 text-foreground">{deviation.variant}</td>
              <td className="py-1.5 text-right font-mono text-foreground">
                {deviation.observed.toLocaleString("en-US")}
              </td>
              <td className="py-1.5 text-right font-mono text-muted-foreground">
                {formatCount(deviation.expected)}
              </td>
              {/* The Worker computes the delta; the Panel only prints it. */}
              <td className="py-1.5 text-right font-mono text-foreground">
                {formatDelta(deviation.delta)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DimensionCuts({ stats }: { stats: StatsOutput }) {
  const cuts = stats.dimension_results ?? [];
  if (cuts.length === 0) return null;
  return (
    <div className="mt-4 border-border border-t pt-3">
      <h4 className="font-medium text-foreground text-sm">Declared Dimension cuts</h4>
      <p className="text-muted-foreground text-xs">
        Sample size per slice, for locating where an imbalance concentrates. Slices are exploratory
        unless the engine marked them decision-valid.
      </p>
      <ul className="mt-2 grid gap-1 text-sm">
        {cuts.map((cut) => (
          <li className="flex flex-wrap gap-x-2" key={`${cut.dimension_id}:${cut.dimension_value}`}>
            <span className="font-mono text-foreground text-xs">
              {cut.dimension_id} = {cut.dimension_value}
            </span>
            <span className="text-muted-foreground text-xs">
              n = {cut.sample_size_n.toLocaleString("en-US")} ·{" "}
              {cut.decision_valid ? "decision-valid" : "exploratory"}
              {cut.low_n_warning ? " · low n" : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function worstTier(srm: ExperimentSrmDiagnostics): SrmSignal["tier"] {
  const tiers = [srm.exposure.tier, srm.activated?.tier, srm.activationBalance?.tier];
  if (tiers.includes("confirmed")) return "confirmed";
  if (tiers.includes("possible_imbalance")) return "possible_imbalance";
  return "clean";
}

function tierLabel(tier: SrmSignal["tier"]): string {
  if (tier === "confirmed") return "Confirmed mismatch";
  if (tier === "possible_imbalance") return "Possible imbalance";
  return "Balanced";
}

function tierCopy(tier: SrmSignal["tier"]): string {
  if (tier === "confirmed") {
    return "Observed traffic does not match the configured split beyond chance. Treat every number on this page as suspect until the cause is found.";
  }
  if (tier === "possible_imbalance") {
    return "The split is off by more than routine noise but short of the mismatch threshold. Worth investigating before concluding.";
  }
  return "Observed traffic matches the configured split within chance.";
}

function surfaceFor(tier: SrmSignal["tier"]): string {
  if (tier === "confirmed") return "border-destructive/40 bg-destructive/5";
  if (tier === "possible_imbalance") return "border-warning/40 bg-warning-muted";
  return "border-border bg-card";
}

function formatP(pValue: number | null): string {
  return pValue === null ? "n/a" : formatPValue(pValue);
}

/** Keeps a fractional expected count visible instead of rounding it away. */
function formatCount(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function formatDelta(value: number): string {
  const shown = Number(value.toFixed(1));
  return `${shown > 0 ? "+" : ""}${formatCount(shown)}`;
}

function countLine(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([variant, count]) => `${variant} ${count.toLocaleString("en-US")}`)
    .join(" · ");
}
