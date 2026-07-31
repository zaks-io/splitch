import type { PanelExperimentDetailOutput } from "@splitch/control-plane-sdk/panel-experiments";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@splitch/ui/components/field";
import { Input } from "@splitch/ui/components/input";
import { Spinner } from "@splitch/ui/components/spinner";
import { useState } from "react";
import {
  buildDecisionPatch,
  type DecisionDraft,
  decisionIssues,
  hasIssue,
} from "#lib/experiment-draft-model";
import { useExperimentDraftPatch } from "#lib/use-experiment-draft-patch";

/**
 * Confidence level and Primary Dimensions. Both are frozen into Run 1 at Start
 * and refused afterwards (ADR-0002 / ADR-0003): editing them once data is
 * visible is alpha shopping or post-hoc Dimension fishing, so this step is the
 * last point at which they are a choice.
 */
export function ExperimentDraftDecisionStep({
  data,
  onSaved,
  scope,
}: {
  data: PanelExperimentDetailOutput;
  onSaved: () => void | Promise<void>;
  scope: { appId: string; environmentId: string };
}) {
  const [draft, setDraft] = useState<DecisionDraft>({
    confidenceLevel: String(data.experiment.confidenceLevel),
    dimensions: data.experiment.dimensions.join(", "),
  });
  const [submitted, setSubmitted] = useState(false);
  const patch = useExperimentDraftPatch(scope, data.experiment.id);
  const issues = decisionIssues(draft);
  // The Run that froze the spec is the RUNNING one, addressed by id: `runs` is
  // not ordered by contract, so `runs[0]` would name whichever Run happened to
  // come back first and could credit the freeze to a Run that ended days ago.
  const liveRun = data.runs.find((run) => run.id === data.experiment.liveRunId);
  // A live Run id with no matching Run is an inconsistent read, not a reason to
  // hand back an editable form for a spec the Worker will refuse to change.
  if (data.experiment.liveRunId !== null && !liveRun) {
    throw new Error(
      `Experiment ${data.experiment.id} names live Run ${data.experiment.liveRunId}, which is absent from its Run history`,
    );
  }

  if (liveRun) {
    return (
      <Alert data-testid="decision-spec-locked">
        <AlertTitle>The decision spec is locked</AlertTitle>
        <AlertDescription>
          Run {liveRun.runNumber} froze a confidence level of {data.experiment.confidenceLevel} and
          Primary Dimensions{" "}
          {data.experiment.dimensions.length > 0 ? data.experiment.dimensions.join(", ") : "(none)"}
          . A Run keeps the spec it was registered with; a different spec needs a new Run.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (hasIssue(issues)) return;
        void patch.save(buildDecisionPatch(draft), onSaved);
      }}
    >
      <FieldGroup>
        <Field data-invalid={Boolean(submitted && issues.confidenceLevel)}>
          <FieldLabel htmlFor="draft-confidence-level">Confidence level</FieldLabel>
          <Input
            aria-invalid={Boolean(submitted && issues.confidenceLevel)}
            id="draft-confidence-level"
            max={0.999}
            min={0.5}
            onChange={(event) =>
              setDraft((current) => ({ ...current, confidenceLevel: event.target.value }))
            }
            step={0.01}
            type="number"
            value={draft.confidenceLevel}
          />
          <FieldDescription>
            Frozen into Run 1 at Start. 0.95 means a 5% false-positive rate per decision.
          </FieldDescription>
          <FieldError>{submitted ? issues.confidenceLevel : null}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="draft-dimensions">Primary Dimensions</FieldLabel>
          <Input
            id="draft-dimensions"
            onChange={(event) =>
              setDraft((current) => ({ ...current, dimensions: event.target.value }))
            }
            placeholder="country, plan"
            value={draft.dimensions}
          />
          <FieldDescription>
            Comma separated, and pre-registered on purpose: a cut declared before Start is a
            hypothesis, the same cut chosen after results are visible is a fishing expedition.
          </FieldDescription>
        </Field>
      </FieldGroup>
      {patch.error ? (
        <Alert className="mt-4" variant="destructive">
          <AlertTitle>Step not saved</AlertTitle>
          <AlertDescription>{patch.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="mt-6 flex justify-end">
        <Button disabled={patch.isSaving} type="submit">
          {patch.isSaving ? <Spinner data-icon="inline-start" /> : null}
          Save and continue
        </Button>
      </div>
    </form>
  );
}
