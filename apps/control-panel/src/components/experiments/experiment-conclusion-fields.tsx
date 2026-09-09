import { Checkbox } from "@splitch/ui/components/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@splitch/ui/components/field";
import { Input } from "@splitch/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@splitch/ui/components/select";
import { Switch } from "@splitch/ui/components/switch";
import { Textarea } from "@splitch/ui/components/textarea";
import type {
  ConclusionDraft,
  ConclusionTarget,
} from "#lib/experiments/experiment-conclusion-model";
import { ExperimentConclusionTargeting } from "./experiment-conclusion-targeting";

export function ExperimentConclusionFields({
  draft,
  target,
  variants,
  update,
  disabled,
}: {
  draft: ConclusionDraft;
  target: ConclusionTarget;
  variants: readonly string[];
  update: (patch: Partial<ConclusionDraft>) => void;
  disabled: boolean;
}) {
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="conclusion-winner">Selected Variant</FieldLabel>
        <Select
          value={draft.selectedVariant}
          onValueChange={(value) => update({ selectedVariant: value ?? "" })}
          disabled={disabled}
        >
          <SelectTrigger id="conclusion-winner">
            <SelectValue placeholder="Choose a Variant" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {variants.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="conclusion-enabled">Flag enabled</FieldLabel>
        <Switch
          id="conclusion-enabled"
          checked={draft.enabled}
          onCheckedChange={(enabled) => update({ enabled })}
          disabled={disabled}
        />
      </Field>
      <FieldSet disabled={disabled}>
        <FieldLegend>Available Variants</FieldLegend>
        <FieldDescription>
          With none selected, availability is not narrowed and every catalog Variant is a candidate.
        </FieldDescription>
        {target.variants.map((variant) => (
          <Field orientation="horizontal" key={variant.id}>
            <Checkbox
              id={`conclusion-available-${variant.id}`}
              checked={draft.availableVariantNames.includes(variant.name)}
              onCheckedChange={(checked) =>
                update({
                  availableVariantNames: checked
                    ? [...draft.availableVariantNames, variant.name]
                    : draft.availableVariantNames.filter((name) => name !== variant.name),
                })
              }
            />
            <FieldLabel htmlFor={`conclusion-available-${variant.id}`}>{variant.name}</FieldLabel>
          </Field>
        ))}
      </FieldSet>
      <Field>
        <FieldLabel>Targeting Rules</FieldLabel>
        <ExperimentConclusionTargeting
          draft={draft}
          target={target}
          update={update}
          disabled={disabled}
        />
      </Field>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="conclusion-rollout-enabled">Baseline rollout</FieldLabel>
        <Switch
          id="conclusion-rollout-enabled"
          checked={draft.hasRollout}
          onCheckedChange={(hasRollout) => update({ hasRollout })}
          disabled={disabled}
        />
      </Field>
      {draft.hasRollout ? (
        <Field>
          <FieldLabel htmlFor="conclusion-rollout">Rollout percentage</FieldLabel>
          <Input
            id="conclusion-rollout"
            type="number"
            min={0}
            max={100}
            value={draft.rolloutPercentage}
            onChange={(event) => update({ rolloutPercentage: event.target.value })}
            disabled={disabled}
          />
        </Field>
      ) : null}
      <Field>
        <FieldLabel htmlFor="conclusion-reason">Reason</FieldLabel>
        <Textarea
          id="conclusion-reason"
          value={draft.reason}
          onChange={(event) => update({ reason: event.target.value })}
          disabled={disabled}
        />
      </Field>
    </FieldGroup>
  );
}
