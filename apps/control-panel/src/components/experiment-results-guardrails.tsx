import type { GuardrailResult, HealthMetrics } from "@splitch/contracts";

/**
 * Guardrails and Run health, placed beside the goal Metric rather than in front
 * of it. A breach is loud but it does not mask the number it qualifies, and it
 * does not by itself block the ship decision: that judgement belongs to a human
 * reading both, so the gate stays about statistical validity.
 */

export function ExperimentResultsGuardrails({
  guardrails,
  health,
}: {
  guardrails: GuardrailResult[];
  health: HealthMetrics;
}) {
  const breached = guardrails.filter((guardrail) => guardrail.is_breached === true);
  return (
    <section
      aria-labelledby="results-guardrails-heading"
      className="rounded-lg border border-border bg-card p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold text-base text-foreground" id="results-guardrails-heading">
          Guardrails and Run health
        </h3>
        {breached.length > 0 ? (
          <span className="font-medium text-destructive text-sm">{breached.length} breached</span>
        ) : null}
      </div>

      {guardrails.length === 0 ? (
        <p className="mt-2 text-muted-foreground text-sm">
          No Guardrail Metric is attached to this Experiment.
        </p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {guardrails.map((guardrail) => (
            <li
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-border border-b pb-2 last:border-b-0 last:pb-0"
              key={`${guardrail.metric_id}:${guardrail.variant}`}
            >
              <span className="text-sm">
                <span className="font-mono text-foreground text-xs">{guardrail.metric_id}</span>
                <span className="text-muted-foreground"> · {guardrail.variant}</span>
              </span>
              <span className="flex flex-wrap items-baseline gap-3 font-mono text-xs">
                <span className="text-muted-foreground">
                  bound {formatBound(guardrail.ci_lower)} vs threshold {guardrail.threshold}
                </span>
                <span
                  className={
                    guardrail.is_breached === true
                      ? "font-medium text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {breachLabel(guardrail)}
                </span>
              </span>
              {guardrail.breach_reason ? (
                <p className="basis-full text-destructive text-xs">{guardrail.breach_reason}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <dl className="mt-4 grid gap-3 border-border border-t pt-3 sm:grid-cols-3">
        <Stat
          hint="Targeting keys seen in more than one Variant. These are quarantined and excluded from the analysis."
          label="__multiple__ quarantine rate"
          value={`${(health.multiple_rate * 100).toFixed(2)}% · ${health.multiple_count.toLocaleString("en-US")} keys`}
        />
        <Stat
          hint="Share of exposed keys that reached the activation Metric."
          label="Activation rates"
          value={
            health.activation_rates
              ? Object.entries(health.activation_rates)
                  .map(([variant, rate]) => `${variant} ${(rate * 100).toFixed(1)}%`)
                  .join(" · ")
              : "no activation Metric"
          }
        />
        <Stat
          hint="Raised when an arm is too small for the configured decision rule."
          label="Sample size"
          value={health.low_n_warning ? "low n warning" : "sufficient"}
        />
      </dl>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-mono text-foreground text-sm">{value}</dd>
      <dd className="text-muted-foreground text-xs">{hint}</dd>
    </div>
  );
}

function breachLabel(guardrail: GuardrailResult): string {
  if (guardrail.is_breached === true) return "breached";
  if (guardrail.is_breached === false) return "within threshold";
  return "not evaluable";
}

function formatBound(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "unbounded";
  return value.toPrecision(3);
}
