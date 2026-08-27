import type { PanelExperimentDetailOutput } from "@splitch/control-plane-sdk/panel-experiments";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@splitch/ui/components/select";
import { Textarea } from "@splitch/ui/components/textarea";
import type { RunDraftState } from "#lib/experiment-run-draft-state";

/**
 * The Run draft fields, rendered identically by the next-Run dialog and by the
 * Experiment-creation flow's Run 1 step. One component means the two callers
 * cannot drift on which fields a Run freezes or on how a bad value is reported.
 */
export function ExperimentRunDraftFields({
  data,
  hasRunningRun,
  idPrefix,
  state,
}: {
  data: PanelExperimentDetailOutput;
  hasRunningRun: boolean;
  idPrefix: string;
  state: RunDraftState;
}) {
  const { draft, errors, setAllocationShare, update } = state;
  return (
    <FieldGroup className="mt-4">
      <FieldSet>
        <FieldLegend>Allocation</FieldLegend>
        <FieldDescription>Set a Variant to 0% to remove it from the next Run.</FieldDescription>
        <div className="grid gap-3 sm:grid-cols-2">
          {Object.entries(draft.allocation).map(([variant, share]) => (
            <Field data-invalid={Boolean(errors.allocation)} key={variant}>
              <FieldLabel htmlFor={`${idPrefix}-allocation-${variant}`}>{variant}</FieldLabel>
              <Input
                aria-invalid={Boolean(errors.allocation)}
                id={`${idPrefix}-allocation-${variant}`}
                max={100}
                min={0}
                onChange={(event) => setAllocationShare(variant, event.target.valueAsNumber)}
                step={1}
                type="number"
                value={Number.isFinite(share) ? share : ""}
              />
            </Field>
          ))}
        </div>
        <FieldError>{errors.allocation}</FieldError>
      </FieldSet>
      <FieldSet>
        <FieldLegend>Assignment identity</FieldLegend>
        {hasRunningRun ? (
          <FieldDescription>
            Frozen until the current Run ends. The running Run's Run Snapshot reads these off the
            Experiment, so there is nowhere to stage a change to them.
          </FieldDescription>
        ) : null}
        <Field data-invalid={Boolean(errors.targetingKey)}>
          <FieldLabel htmlFor={`${idPrefix}-targeting-key`}>Targeting Key</FieldLabel>
          <Input
            aria-invalid={Boolean(errors.targetingKey)}
            disabled={hasRunningRun}
            id={`${idPrefix}-targeting-key`}
            onChange={(event) => update({ targetingKey: event.target.value })}
            value={draft.targetingKey}
          />
          <FieldError>{errors.targetingKey}</FieldError>
        </Field>
        <Field data-invalid={Boolean(errors.targetingKeyType)}>
          <FieldLabel htmlFor={`${idPrefix}-entity-type`}>Entity type</FieldLabel>
          <Input
            aria-invalid={Boolean(errors.targetingKeyType)}
            disabled={hasRunningRun}
            id={`${idPrefix}-entity-type`}
            onChange={(event) => update({ targetingKeyType: event.target.value })}
            value={draft.targetingKeyType}
          />
          <FieldError>{errors.targetingKeyType}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-activation-metric`}>Activation Metric ID</FieldLabel>
          <Input
            disabled={hasRunningRun}
            id={`${idPrefix}-activation-metric`}
            list={`${idPrefix}-metric-options`}
            onChange={(event) => update({ activationMetricId: event.target.value })}
            placeholder="None"
            value={draft.activationMetricId}
          />
          <datalist id={`${idPrefix}-metric-options`}>
            {data.metrics.map((metric) => (
              <option key={metric.id} value={metric.id}>
                {metric.name}
              </option>
            ))}
          </datalist>
        </Field>
      </FieldSet>
      <FieldSet>
        <FieldLegend>Horizon</FieldLegend>
        <FieldDescription>
          Frozen into the Run at Start and never editable afterwards: changing how a Run decides
          once its data is visible is alpha shopping.
        </FieldDescription>
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-horizon`}>Horizon mode</FieldLabel>
          <Select
            onValueChange={(value) =>
              update({
                horizon: value === "fixed" ? "fixed" : "sequential",
                ...(value === "fixed" ? {} : { sampleSize: "" }),
              })
            }
            value={draft.horizon}
          >
            <SelectTrigger className="w-full" id={`${idPrefix}-horizon`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sequential">Sequential (always-valid, peek any time)</SelectItem>
              <SelectItem value="fixed">Fixed sample size (pre-registered)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {draft.horizon === "fixed" ? (
          <Field data-invalid={Boolean(errors.horizon)}>
            <FieldLabel htmlFor={`${idPrefix}-sample-size`}>Pre-registered sample size</FieldLabel>
            <Input
              aria-invalid={Boolean(errors.horizon)}
              id={`${idPrefix}-sample-size`}
              min={1}
              onChange={(event) => update({ sampleSize: event.target.value })}
              step={1}
              type="number"
              value={draft.sampleSize}
            />
            <FieldError>{errors.horizon}</FieldError>
          </Field>
        ) : null}
      </FieldSet>
      <Field data-invalid={Boolean(errors.targetingRules)}>
        <FieldLabel htmlFor={`${idPrefix}-targeting-rules`}>Targeting Rules</FieldLabel>
        <Textarea
          aria-invalid={Boolean(errors.targetingRules)}
          className="min-h-32 font-mono"
          id={`${idPrefix}-targeting-rules`}
          onChange={(event) => update({ targetingRules: event.target.value })}
          value={draft.targetingRules}
        />
        <FieldError>{errors.targetingRules}</FieldError>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-salt`}>Salt override</FieldLabel>
        <Input
          id={`${idPrefix}-salt`}
          onChange={(event) => update({ salt: event.target.value })}
          placeholder="Generated at Start"
          value={draft.salt}
        />
        <FieldDescription>Leave blank for a fresh server-generated salt.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-reason`}>Why open this Run?</FieldLabel>
        <Textarea
          id={`${idPrefix}-reason`}
          onChange={(event) => update({ reason: event.target.value })}
          placeholder="Testing a larger treatment allocation"
          value={draft.reason}
        />
      </Field>
    </FieldGroup>
  );
}
