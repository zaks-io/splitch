import type { PanelExperimentResultsReady } from "@splitch/control-plane-sdk/panel-experiments";
import { ExperimentResultsCiPlot } from "./experiment-results-ci-plot";
import { baselineLabel, ExperimentResultsControlIntegrity } from "./experiment-results-control";
import { ExperimentResultsDecision } from "./experiment-results-decision";
import { ExperimentResultsGuardrails } from "./experiment-results-guardrails";
import { ExperimentResultsMetricsTable } from "./experiment-results-metrics-table";
import { ExperimentResultsSrm } from "./experiment-results-srm";

/**
 * The Results tab for exactly one Run.
 *
 * Order is deliberate: the numbers come first and are always present. Warnings
 * qualify the numbers, they never replace them, because an operator diagnosing
 * a firing SRM needs the arm counts more than anyone. The ship decision comes
 * last and is the only thing a failing check is allowed to withhold.
 */

export function ExperimentResults({ results }: { results: PanelExperimentResultsReady }) {
  return (
    <section aria-labelledby="results-heading" className="grid gap-6">
      <header className="grid gap-1">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.16em]">
          Run {results.runNumber} · {results.runStatus}
        </p>
        <h2 className="font-semibold text-foreground text-xl" id="results-heading">
          Results
        </h2>
        <p className="max-w-prose text-muted-foreground text-sm">
          Measured on Run {results.runNumber} alone. splitch never pools data across Runs, so a
          configuration change always starts a fresh analysis window.
        </p>
      </header>

      <ExperimentResultsControlIntegrity control={results.control} />

      <div className="rounded-lg border border-border bg-card p-5 shadow-sm">
        <h3 className="font-semibold text-base text-foreground">Lift by arm</h3>
        <p className="mt-1 mb-4 max-w-prose text-muted-foreground text-sm">
          Relative lift against {baselineLabel(results.control)}, with an always-valid confidence
          sequence. Checking mid-Run is safe: the interval already accounts for continuous peeking.
        </p>
        <ExperimentResultsCiPlot
          control={results.control}
          results={results.stats.arm_results}
          significance={results.significance}
        />
      </div>

      <ExperimentResultsMetricsTable
        control={results.control}
        results={results.stats.arm_results}
        significance={results.significance}
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <ExperimentResultsSrm srm={results.srm} stats={results.stats} />
        <ExperimentResultsGuardrails
          guardrails={results.stats.guardrail_results}
          health={results.stats.health}
        />
      </div>

      <ExperimentResultsDecision
        gate={results.gate}
        guardrails={results.stats.guardrail_results}
        runStatus={results.runStatus}
      />
    </section>
  );
}

export function ExperimentResultsEmpty() {
  return (
    <section
      aria-labelledby="results-heading"
      className="rounded-lg border border-border bg-card p-6 shadow-sm"
    >
      <h2 className="font-semibold text-foreground text-xl" id="results-heading">
        Results
      </h2>
      <p className="mt-2 max-w-prose text-muted-foreground text-sm leading-6">
        This Experiment has no Run yet. Start it to open Run 1 and begin collecting exposures.
        Nothing is measured, and no decision can be made, until a Run exists.
      </p>
    </section>
  );
}

/**
 * Healthy early-Run collecting state: Analysis answered 200 `no_data` (same
 * discriminator as attention-rollup). Distinct from a failed read, which the
 * route `errorComponent` surfaces as "Results unavailable".
 */
export function ExperimentResultsWaiting({
  missing,
  runNumber,
}: {
  missing: "exposures" | "metric_events";
  runNumber: number;
}) {
  const waitingOn =
    missing === "exposures"
      ? "Exposures have not arrived for this Run yet."
      : "Exposures are in; Metric Events have not arrived yet.";

  return (
    <section
      aria-labelledby="results-heading"
      className="rounded-lg border border-border bg-card p-6 shadow-sm"
      data-testid="results-waiting"
    >
      <header className="grid gap-1">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.16em]">
          Run {runNumber} · collecting
        </p>
        <h2 className="font-semibold text-foreground text-xl" id="results-heading">
          Waiting for data
        </h2>
        <p className="mt-2 max-w-prose text-muted-foreground text-sm leading-6">
          {waitingOn} Results will appear here once both inputs are present. This is not an outage —
          a freshly started Run always looks like this until the data plane catches up.
        </p>
      </header>
    </section>
  );
}
