import type { PanelExperimentDetailOutput } from "@splitch/control-plane-sdk/panel-experiments";
import { Badge } from "@splitch/ui/components/badge";
import { Card, CardContent, CardDescription, CardHeader } from "@splitch/ui/components/card";
import { useNavigate } from "@tanstack/react-router";
import { ActiveEnvironmentBadge } from "#components/environments/active-environment-badge";
import { ExperimentDraftDecisionStep } from "#components/experiments/experiment-draft-decision-step";
import { ExperimentDraftMeasurementStep } from "#components/experiments/experiment-draft-measurement-step";
import { ExperimentDraftRunStep } from "#components/experiments/experiment-draft-run-step";
import {
  EXPERIMENT_DRAFT_STEP_LABELS,
  EXPERIMENT_DRAFT_STEPS,
  type ExperimentDraftStep,
} from "#lib/experiments/experiment-draft-model";
import { experimentKeyRouteRef } from "#lib/experiments/experiment-route-navigation";

/**
 * The guided draft. Every step writes to the same `draft` Experiment row, so the
 * step in the URL is navigation only: leaving here and returning resumes from
 * what the Control Plane stored, not from browser state.
 */
export function ExperimentDraftWizard({
  data,
  scope,
  scopeHref,
  step,
}: {
  data: PanelExperimentDetailOutput;
  scope: { appId: string; environmentId: string; env: string };
  scopeHref: string;
  step: ExperimentDraftStep;
}) {
  const navigate = useNavigate();
  const experimentHref = `${scopeHref}/experiments/${experimentKeyRouteRef(data.experiment.key)}`;
  const goTo = (next: ExperimentDraftStep) =>
    navigate({ href: `${experimentHref}/draft?step=${next}` });

  return (
    <Card className="mx-auto w-full max-w-3xl">
      <CardHeader>
        <ActiveEnvironmentBadge env={scope.env} />
        <CardDescription>
          Draft Experiment · {data.experiment.name} · Flag {data.flag.name}
        </CardDescription>
        <h2 className="font-semibold text-foreground text-xl" id="draft-step-heading">
          {EXPERIMENT_DRAFT_STEP_LABELS[step]}
        </h2>
        <nav aria-label="Draft steps" className="mt-2 flex flex-wrap gap-2">
          {EXPERIMENT_DRAFT_STEPS.map((candidate, index) => (
            <a
              className="focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={`${experimentHref}/draft?step=${candidate}`}
              key={candidate}
            >
              <Badge variant={candidate === step ? "secondary" : "outline"}>
                {index + 1}. {EXPERIMENT_DRAFT_STEP_LABELS[candidate]}
              </Badge>
            </a>
          ))}
        </nav>
      </CardHeader>
      <CardContent>
        {step === "measurement" ? (
          <ExperimentDraftMeasurementStep
            data={data}
            onSaved={() => goTo("decision")}
            scope={scope}
          />
        ) : null}
        {step === "decision" ? (
          <ExperimentDraftDecisionStep data={data} onSaved={() => goTo("run")} scope={scope} />
        ) : null}
        {step === "run" ? (
          <ExperimentDraftRunStep
            data={data}
            onStarted={() => {
              // Setup, not Results: the Run was opened a second ago, so it has no
              // Exposures and therefore nothing to decide on. Its frozen Setup is
              // what the operator just chose and the confirmation that it landed.
              void navigate({ href: `${experimentHref}/setup` });
            }}
            scope={scope}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
