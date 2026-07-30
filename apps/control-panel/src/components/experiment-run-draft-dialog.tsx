import type {
  PanelExperimentDetailOutput,
  PanelExperimentRun,
} from "@splitch/control-plane-sdk/panel-experiments";
import { Button } from "@splitch/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@splitch/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@splitch/ui/components/field";
import { Input } from "@splitch/ui/components/input";
import { Textarea } from "@splitch/ui/components/textarea";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { stageAndStartControlPanelExperimentRun } from "#lib/control-plane-experiment-functions";
import {
  buildRunStartInput,
  initialRunDraft,
  targetingRulesError,
} from "#lib/experiment-run-draft-model";
import { ExperimentRunStartConfirmation } from "./experiment-run-start-confirmation";

export function ExperimentRunDraftDialog({
  appId,
  data,
  environmentId,
}: {
  appId: string;
  data: PanelExperimentDetailOutput;
  environmentId: string;
}) {
  const baseRun = data.runs.find((run) => run.status === "running") ?? data.runs[0];
  const nextRunNumber = (baseRun?.runNumber ?? 0) + 1;
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button variant="outline" />}>
        Configure Run {nextRunNumber}
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <ExperimentRunDraftForm
          appId={appId}
          baseRun={baseRun}
          data={data}
          environmentId={environmentId}
          nextRunNumber={nextRunNumber}
          onStarted={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function ExperimentRunDraftForm({
  appId,
  baseRun,
  data,
  environmentId,
  nextRunNumber,
  onStarted,
}: {
  appId: string;
  baseRun: PanelExperimentRun | undefined;
  data: PanelExperimentDetailOutput;
  environmentId: string;
  nextRunNumber: number;
  onStarted: () => void;
}) {
  const router = useRouter();
  const hasRunningRun = data.runs.some((run) => run.status === "running");
  const initial = initialRunDraft(data, baseRun);
  const [allocation, setAllocation] = useState(initial.allocation);
  const [targetingKey, setTargetingKey] = useState(initial.targetingKey);
  const [targetingKeyType, setTargetingKeyType] = useState(initial.targetingKeyType);
  const [activationMetricId, setActivationMetricId] = useState(initial.activationMetricId);
  const [salt, setSalt] = useState("");
  const [targetingRules, setTargetingRules] = useState(initial.targetingRules);
  const [reason, setReason] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [step, setStep] = useState<"configure" | "confirm">("configure");
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string>();
  const allocationTotal = Object.values(allocation).reduce((total, share) => total + share, 0);
  const allocationError =
    Math.abs(allocationTotal - 100) > 1e-6
      ? `Allocation must total 100%. It currently totals ${allocationTotal}%.`
      : null;
  const targetingError = targetingRulesError(targetingRules);

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    if (draftIsInvalid(targetingKey, targetingKeyType, allocationError, targetingError)) return;
    setStep("confirm");
  }

  async function start() {
    setIsStarting(true);
    setError(undefined);
    try {
      const parsedRules = JSON.parse(targetingRules) as unknown[];
      const result = await stageAndStartControlPanelExperimentRun({
        data: buildRunStartInput({
          activationMetricId,
          allocation,
          appId,
          environmentId,
          experimentId: data.experiment.id,
          idempotencyKey,
          reason,
          salt,
          targetingKey,
          targetingKeyType,
          targetingRules: parsedRules,
        }),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      await router.invalidate();
      onStarted();
    } catch {
      setError("The Control Plane could not Start this Experiment Run. Try again.");
    } finally {
      setIsStarting(false);
    }
  }

  if (step === "confirm") {
    return (
      <ExperimentRunStartConfirmation
        baseRun={baseRun}
        error={error}
        isStarting={isStarting}
        nextRunNumber={nextRunNumber}
        onBack={() => setStep("configure")}
        onStart={start}
      />
    );
  }

  return (
    <form onSubmit={review}>
      <DialogHeader>
        <DialogTitle>Configure Run {nextRunNumber}</DialogTitle>
        <DialogDescription>
          Assignment config is pre-filled from {baseRun ? `Run ${baseRun.runNumber}` : "the draft"}.
          Nothing changes until Start is confirmed.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup className="mt-4">
        <FieldSet>
          <FieldLegend>Allocation</FieldLegend>
          <FieldDescription>Set a Variant to 0% to remove it from the next Run.</FieldDescription>
          <div className="grid gap-3 sm:grid-cols-2">
            {Object.entries(allocation).map(([variant, share]) => (
              <Field data-invalid={Boolean(allocationError)} key={variant}>
                <FieldLabel htmlFor={`next-run-allocation-${variant}`}>{variant}</FieldLabel>
                <Input
                  aria-invalid={Boolean(allocationError)}
                  id={`next-run-allocation-${variant}`}
                  max={100}
                  min={0}
                  onChange={(event) =>
                    setAllocation((current) => ({
                      ...current,
                      [variant]: event.target.valueAsNumber,
                    }))
                  }
                  step={1}
                  type="number"
                  value={share}
                />
              </Field>
            ))}
          </div>
          <FieldError>{allocationError}</FieldError>
        </FieldSet>
        <FieldSet>
          <FieldLegend>Assignment identity</FieldLegend>
          {hasRunningRun ? (
            <FieldDescription>
              Frozen until the current Run ends. The running Run's published config reads these off
              the Experiment, so there is nowhere to stage a change to them.
            </FieldDescription>
          ) : null}
          <Field>
            <FieldLabel htmlFor="next-run-targeting-key">Targeting Key</FieldLabel>
            <Input
              disabled={hasRunningRun}
              id="next-run-targeting-key"
              onChange={(event) => setTargetingKey(event.target.value)}
              value={targetingKey}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="next-run-entity-type">Entity type</FieldLabel>
            <Input
              disabled={hasRunningRun}
              id="next-run-entity-type"
              onChange={(event) => setTargetingKeyType(event.target.value)}
              value={targetingKeyType}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="next-run-activation-metric">Activation Metric ID</FieldLabel>
            <Input
              disabled={hasRunningRun}
              id="next-run-activation-metric"
              list="experiment-metric-options"
              onChange={(event) => setActivationMetricId(event.target.value)}
              placeholder="None"
              value={activationMetricId}
            />
            <datalist id="experiment-metric-options">
              {data.metrics.map((metric) => (
                <option key={metric.id} value={metric.id}>
                  {metric.name}
                </option>
              ))}
            </datalist>
          </Field>
        </FieldSet>
        <Field data-invalid={Boolean(targetingError)}>
          <FieldLabel htmlFor="next-run-targeting-rules">Targeting Rules</FieldLabel>
          <Textarea
            aria-invalid={Boolean(targetingError)}
            className="min-h-32 font-mono"
            id="next-run-targeting-rules"
            onChange={(event) => setTargetingRules(event.target.value)}
            value={targetingRules}
          />
          <FieldError>{targetingError}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="next-run-salt">Salt override</FieldLabel>
          <Input
            id="next-run-salt"
            onChange={(event) => setSalt(event.target.value)}
            placeholder="Generated at Start"
            value={salt}
          />
          <FieldDescription>Leave blank for a fresh server-generated salt.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="next-run-reason">Why open this Run?</FieldLabel>
          <Textarea
            id="next-run-reason"
            onChange={(event) => setReason(event.target.value)}
            placeholder="Testing a larger treatment allocation"
            value={reason}
          />
        </Field>
      </FieldGroup>
      <DialogFooter className="mt-4">
        <Button type="submit">Review Start</Button>
      </DialogFooter>
    </form>
  );
}

function draftIsInvalid(
  targetingKey: string,
  targetingKeyType: string,
  allocationError: string | null,
  targetingError: string | null,
): boolean {
  return (
    !targetingKey.trim() || !targetingKeyType.trim() || Boolean(allocationError || targetingError)
  );
}
