import type { FrozenControlIdentity } from "@splitch/contracts";
import type {
  PanelExperimentResultsReady,
  PanelExperimentRun,
} from "@splitch/control-plane-sdk/panel-experiments";
import { ExperimentResultsArms } from "./experiment-results-arms";
import {
  analysisControlVariant,
  ExperimentResultsControlIntegrity,
} from "./experiment-results-control";
import { ExperimentResultsDecision } from "./experiment-results-decision";
import { ExperimentResultsHero } from "./experiment-results-hero";
import { ExperimentResultsStations } from "./experiment-results-stations";

/**
 * The Results tab for exactly one Run.
 *
 * Order is deliberate: the numbers come first and are always present. Warnings
 * qualify the numbers, they never replace them, because an operator diagnosing
 * a firing SRM needs the arm counts more than anyone. The ship decision comes
 * last and is the only thing a failing check is allowed to withhold.
 */

export function ExperimentResults({
  results,
  run,
}: {
  results: PanelExperimentResultsReady;
  run: PanelExperimentRun;
}) {
  const measurementAnchor = analysisControlVariant(results.control);
  const variantOrder = frozenVariantNames(run.variantsJson);
  return (
    <section aria-labelledby="results-heading" className="grid">
      <ExperimentResultsHero
        baseline={measurementAnchor}
        results={results}
        run={run}
        variantOrder={variantOrder}
      />

      {results.control.state === "frozen" ? null : (
        <div className="mt-6">
          <ExperimentResultsControlIntegrity control={results.control} resultsRendered={true} />
        </div>
      )}

      <div className="pt-9">
        <ExperimentResultsArms
          allocation={run.allocation}
          baseline={measurementAnchor}
          dedupedCounts={results.stats.health.deduped_counts}
          variantOrder={variantOrder}
        />
        <ExperimentResultsStations
          baseline={measurementAnchor}
          results={results}
          variantOrder={variantOrder}
        />
        <ExperimentResultsDecision
          baseline={measurementAnchor}
          control={results.control}
          gate={results.gate}
          guardrails={results.stats.guardrail_results}
          runStatus={results.runStatus}
          variantOrder={variantOrder}
        />
      </div>
    </section>
  );
}

function frozenVariantNames(raw: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Run variantsJson is not valid JSON");
  }
  if (!Array.isArray(value) || value.length === 0) throw new Error("Run has no frozen Variants");
  const names = value.map((variant) => {
    if (
      typeof variant !== "object" ||
      variant === null ||
      !("name" in variant) ||
      typeof variant.name !== "string" ||
      variant.name.length === 0
    ) {
      throw new Error("Run contains a frozen Variant without a name");
    }
    return variant.name;
  });
  if (new Set(names).size !== names.length) throw new Error("Run contains duplicate Variant names");
  return names;
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
 * Analysis answered 200 `no_data` (same discriminator as attention-rollup).
 * Distinct from a failed read, which the route `errorComponent` surfaces as
 * "Results unavailable". An ended Run is not collecting: nothing more will
 * arrive for a missing input.
 */
export function ExperimentResultsWaiting({
  control,
  missing,
  runNumber,
  runStatus,
}: {
  control: FrozenControlIdentity;
  missing: "exposures" | "metric_events";
  runNumber: number;
  runStatus: "running" | "ended";
}) {
  const ended = runStatus === "ended";
  const detail = ended
    ? missing === "exposures"
      ? "This Run ended with no Exposures. There is nothing to measure."
      : "This Run ended with Exposures but no Metric Events. Nothing further will arrive."
    : missing === "exposures"
      ? "Exposures have not arrived for this Run yet. Results will appear here once both inputs are present."
      : "Exposures are in; Metric Events have not arrived yet. Results will appear here once both inputs are present.";

  return (
    <section
      aria-labelledby="results-heading"
      className="grid gap-6 rounded-lg border border-border bg-card p-6 shadow-sm"
      data-testid="results-waiting"
    >
      <header className="grid gap-1">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.16em]">
          Run {runNumber} · {runStatus}
        </p>
        <h2 className="font-semibold text-foreground text-xl" id="results-heading">
          {ended ? "No data for this Run" : "Waiting for data"}
        </h2>
        <p className="mt-2 max-w-prose text-muted-foreground text-sm leading-6">{detail}</p>
      </header>
      <ExperimentResultsControlIntegrity control={control} resultsRendered={false} />
    </section>
  );
}
