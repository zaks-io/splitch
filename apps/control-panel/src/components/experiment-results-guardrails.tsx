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
              {/* breach_reason restates the same two numbers as the line above
                  it, at raw float precision. The formatted pair is the honest
                  rendering of the same fact, so the string is not repeated. */}
            </li>
          ))}
        </ul>
      )}

      <dl className="mt-4 grid gap-3 border-border border-t pt-3 sm:grid-cols-3">
        <Stat
          hint={`Targeting keys seen in more than one Variant. These are quarantined and excluded from the analysis. Tolerance is ${(MULTIPLE_RATE_TOLERANCE * 100).toFixed(0)}%.`}
          label="__multiple__ quarantine rate"
          tone={health.multiple_rate > MULTIPLE_RATE_TOLERANCE ? "warn" : "ok"}
          value={`${(health.multiple_rate * 100).toFixed(2)}% · ${health.multiple_count.toLocaleString("en-US")} keys`}
        />
        <Stat
          hint="Share of exposed keys that reached the activation Metric."
          label="Activation rates"
          tone="neutral"
          value={
            health.activation_rates
              ? Object.entries(health.activation_rates)
                  .map(([variant, rate]) => `${variant} ${(rate * 100).toFixed(1)}%`)
                  .join(" · ")
              : "no activation Metric"
          }
        />
        {/* "Sufficient" would claim a power calculation this number cannot
            support. The engine raised a warning or it did not. */}
        <Stat
          hint="The engine raises this when an arm is below the minimum Entity count. Its absence is not a power calculation."
          label="Sample size"
          tone={health.low_n_warning ? "warn" : "ok"}
          value={health.low_n_warning ? "low-n warning raised" : "no low-n warning"}
        />
      </dl>
    </section>
  );
}

/** docs/spec/stats/srm-and-health.md: above this share, quarantine is loud. */
const MULTIPLE_RATE_TOLERANCE = 0.01;

type StatTone = "neutral" | "ok" | "warn";

const STAT_TONE: Record<StatTone, { glyph: string; label: string; className: string }> = {
  neutral: { glyph: "·", label: "", className: "text-foreground" },
  ok: { glyph: "✓", label: "Within tolerance", className: "text-success" },
  warn: { glyph: "!", label: "Outside tolerance", className: "text-warning-foreground" },
};

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: StatTone;
}) {
  const { glyph, label: toneLabel, className } = STAT_TONE[tone];
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={`flex items-baseline gap-1.5 font-mono text-sm ${className}`}>
        {toneLabel ? (
          <span aria-label={toneLabel} role="img">
            {glyph}
          </span>
        ) : null}
        <span>{value}</span>
      </dd>
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
