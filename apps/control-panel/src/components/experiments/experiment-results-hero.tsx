import type { ArmResult, GuardrailResult } from "@splitch/contracts";
import { formatPValue } from "@splitch/contracts";
import type {
  PanelExperimentResultsReady,
  PanelExperimentRun,
} from "@splitch/control-plane-sdk/panel-experiments";
import { armColor } from "#lib/experiments/arm-colors";
import {
  experimentResultsVerdict,
  leadingSignificantResult,
  worstGuardrailBreach,
} from "#lib/experiments/experiment-results-verdict";
import { formatLift } from "./experiment-results-format";

export function ExperimentResultsHero({
  results,
  run,
  baseline,
  variantOrder,
}: {
  results: PanelExperimentResultsReady;
  run: PanelExperimentRun;
  baseline: string;
  variantOrder: readonly string[];
}) {
  const breached = results.stats.guardrail_results.filter(
    (guardrail) => guardrail.is_breached === true,
  );
  const leading = leadingSignificantResult({
    armResults: results.stats.arm_results,
    significance: results.significance,
    baseline,
  });
  const verdict = experimentResultsVerdict({
    armResults: results.stats.arm_results,
    significance: results.significance,
    guardrails: results.stats.guardrail_results,
    gate: results.gate,
    baseline,
  });
  const dedupedTotal = Object.values(results.stats.health.deduped_counts).reduce(
    (total, count) => total + count,
    0,
  );
  const worstBreach = worstGuardrailBreach(breached, results.stats.arm_results);

  return (
    <section
      aria-labelledby="results-heading"
      className="rounded-xl border border-border bg-card p-5 shadow-sm sm:p-7"
    >
      <div className="flex flex-col gap-7 lg:flex-row lg:items-start lg:gap-10">
        <div className="min-w-0 flex-1">
          <HeroChips breachedCount={breached.length} shipAllowed={results.gate.shipAllowed} />
          <VerdictHeading baseline={baseline} segments={verdict} variantOrder={variantOrder} />

          <p className="mt-4 max-w-[70ch] text-muted-foreground text-sm leading-relaxed">
            Measured on Run {results.runNumber} alone. splitch never pools data across Runs. Peeking
            is safe because every interval is an always-valid confidence sequence.
          </p>
        </div>

        <HeroTiles
          baseline={baseline}
          dedupedTotal={dedupedTotal}
          leading={leading}
          results={results}
          run={run}
          variantOrder={variantOrder}
          worstBreach={worstBreach}
        />
      </div>
    </section>
  );
}

function HeroChips({
  breachedCount,
  shipAllowed,
}: {
  breachedCount: number;
  shipAllowed: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1 font-medium text-xs ${
          shipAllowed
            ? "border-success/40 bg-success-muted text-success-foreground"
            : "border-destructive/40 bg-destructive/5 text-destructive"
        }`}
      >
        <span aria-hidden="true" className="font-mono">
          {shipAllowed ? "✓" : "✕"}
        </span>
        {shipAllowed ? "No blocking check" : "Blocked"}
      </span>
      {breachedCount > 0 ? (
        <span className="inline-flex items-center gap-2 rounded-md border border-warning/40 bg-warning-muted px-2.5 py-1 font-medium text-warning-foreground text-xs">
          <span aria-hidden="true">▲</span>
          {breachedCount} Guardrail{breachedCount === 1 ? "" : "s"} breached
        </span>
      ) : null}
    </div>
  );
}

function VerdictHeading({
  baseline,
  segments,
  variantOrder,
}: {
  baseline: string;
  segments: ReturnType<typeof experimentResultsVerdict>;
  variantOrder: readonly string[];
}) {
  const occurrences = new Map<string, number>();
  return (
    <h2
      className="mt-4 max-w-[30ch] font-semibold text-2xl text-foreground leading-tight tracking-tight sm:text-3xl"
      id="results-heading"
    >
      {segments.map((segment) => {
        const identity = `${segment.kind}:${segment.value}`;
        const occurrence = occurrences.get(identity) ?? 0;
        occurrences.set(identity, occurrence + 1);
        return (
          <span
            className={
              segment.kind === "metric" || segment.kind === "value" ? "font-mono" : undefined
            }
            key={`${identity}:${occurrence}`}
            style={
              segment.kind === "arm"
                ? { color: armColor({ baseline, variant: segment.value, variantOrder }) }
                : undefined
            }
          >
            {segment.value}
          </span>
        );
      })}
    </h2>
  );
}

function HeroTiles({
  baseline,
  dedupedTotal,
  leading,
  results,
  run,
  variantOrder,
  worstBreach,
}: {
  baseline: string;
  dedupedTotal: number;
  leading: ArmResult | null;
  results: PanelExperimentResultsReady;
  run: PanelExperimentRun;
  variantOrder: readonly string[];
  worstBreach: { guardrail: GuardrailResult; armResult: ArmResult | undefined } | null;
}) {
  return (
    <div className="grid w-full shrink-0 grid-cols-2 gap-x-6 gap-y-6 sm:gap-x-10 lg:w-[25rem]">
      <StatTile
        detail={variantOrder
          .map((variant) => requiredCount(results.stats.health.deduped_counts, variant))
          .map((count) => count.toLocaleString("en-US"))
          .join(" / ")}
        label="Deduped exposures"
        value={dedupedTotal.toLocaleString("en-US")}
      />
      <StatTile
        label={run.endedAt === null ? "Runtime" : "Ran for"}
        value={formatRuntime(run.startedAt, run.endedAt)}
      />
      <StatTile
        detail={leading ? `${leading.variant} · ${leading.metric_id}` : undefined}
        label={leading ? "Significant lift" : "No significance call yet"}
        muted={leading === null}
        tone={leading ? armColor({ baseline, variant: leading.variant, variantOrder }) : undefined}
        value={leading ? formatLift(leading.relative_lift_pct) : "–"}
      />
      {worstBreach ? (
        <StatTile
          detail={`${worstBreach.guardrail.variant} · threshold ${formatThreshold(worstBreach.guardrail.threshold)}`}
          label={`${worstBreach.guardrail.metric_id} breached`}
          tone="var(--warning-foreground)"
          value={breachValue(worstBreach.guardrail, worstBreach.armResult)}
        />
      ) : (
        <HealthTile results={results} />
      )}
    </div>
  );
}

function StatTile({
  value,
  label,
  detail,
  tone,
  muted = false,
}: {
  value: string;
  label: string;
  detail?: string;
  tone?: string;
  muted?: boolean;
}) {
  return (
    <div>
      <div
        className={`font-medium font-mono text-2xl leading-none tracking-tight sm:text-3xl ${muted ? "text-muted-foreground" : "text-foreground"}`}
        style={tone ? { color: tone } : undefined}
      >
        {value}
      </div>
      <div className="mt-2 font-medium text-muted-foreground text-xs">{label}</div>
      {detail ? (
        <div className="mt-1 break-words font-mono text-muted-foreground text-xs">{detail}</div>
      ) : null}
    </div>
  );
}

function HealthTile({ results }: { results: PanelExperimentResultsReady }) {
  const tier = results.srm.exposure.tier;
  const tone =
    tier === "clean"
      ? "var(--success)"
      : tier === "confirmed"
        ? "var(--destructive)"
        : "var(--warning-foreground)";
  const value = tier === "clean" ? "✓" : tier === "confirmed" ? "✕" : "!";
  const label =
    tier === "clean"
      ? "Run health"
      : tier === "confirmed"
        ? "Confirmed mismatch"
        : "Possible imbalance";
  const pValue = results.srm.exposure.pValue;
  return (
    <StatTile
      detail={pValue === null ? "p = n/a" : `p = ${formatPValue(pValue)}`}
      label={label}
      tone={tone}
      value={value}
    />
  );
}

function breachValue(guardrail: GuardrailResult, armResult: ArmResult | undefined): string {
  return armResult?.relative_lift_pct === null || armResult?.relative_lift_pct === undefined
    ? `${formatThreshold(guardrail.ci_lower)} vs ${formatThreshold(guardrail.threshold)}`
    : formatLift(armResult.relative_lift_pct);
}

function formatThreshold(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "unbounded";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatRuntime(startedAt: string, endedAt: string | null): string {
  const start = Date.parse(startedAt);
  const end = endedAt === null ? Date.now() : Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end))
    throw new Error("Run timestamps are invalid");
  if (end < start) throw new Error("Run ended before it started");
  const elapsedHours = Math.floor((end - start) / 3_600_000);
  const days = Math.floor(elapsedHours / 24);
  const hours = elapsedHours % 24;
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

function requiredCount(counts: Record<string, number>, variant: string): number {
  const count = counts[variant];
  if (count === undefined) throw new Error(`Missing deduped exposure count for Variant ${variant}`);
  return count;
}
