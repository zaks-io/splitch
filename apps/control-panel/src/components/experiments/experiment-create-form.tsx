import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import { Card, CardContent, CardHeader } from "@splitch/ui/components/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@splitch/ui/components/field";
import { Input } from "@splitch/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@splitch/ui/components/select";
import { Spinner } from "@splitch/ui/components/spinner";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { createControlPanelExperiment } from "#lib/experiments/control-plane-experiment-functions";
import { controlPlaneErrorMessage } from "#lib/shared/control-plane-error-message";
import {
  buildCreateExperimentInput,
  type ExperimentBasicsDraft,
  experimentBasicsIssues,
  hasIssue,
} from "#lib/experiments/experiment-draft-model";

/**
 * Step 1 of Experiment creation. Submitting writes a REAL `draft` Experiment, so
 * the remaining steps edit a persisted row and an operator can leave and resume.
 * Nothing here opens a Run.
 */
export function ExperimentCreateForm({
  flags,
  scope,
  scopeHref,
}: {
  flags: Array<{ id: string; key: string }>;
  scope: { appId: string; environmentId: string };
  scopeHref: string;
}) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<ExperimentBasicsDraft>({
    name: "",
    key: "",
    flagId: "",
    targetingKey: "userId",
    targetingKeyType: "user",
  });
  const [submitted, setSubmitted] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const issues = experimentBasicsIssues(draft);
  const shown = (field: keyof ExperimentBasicsDraft) => (submitted ? issues[field] : null);

  function update(patch: Partial<ExperimentBasicsDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    setError(undefined);
    if (hasIssue(issues)) return;
    setIsSaving(true);
    try {
      const result = await createControlPanelExperiment({
        data: buildCreateExperimentInput(scope, draft, idempotencyKey),
      });
      if (!result.ok) {
        setError(controlPlaneErrorMessage(result.error));
        return;
      }
      await navigate({
        href: `${scopeHref}/experiments/${encodeURIComponent(result.data.experimentId)}/draft`,
      });
    } catch {
      setError("The Control Plane could not create this Experiment draft. Try again.");
    } finally {
      setIsSaving(false);
    }
  }

  if (flags.length === 0) {
    return (
      <Alert variant="destructive">
        <AlertTitle>No Flag to experiment on</AlertTitle>
        <AlertDescription>
          An Experiment controls the allocation of exactly one Flag, so this Environment needs a
          Flag with Variants first. <a href={`${scopeHref}/flags`}>Create a Flag</a>, then come
          back.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="font-semibold text-foreground text-xl" id="experiment-create-heading">
          New Experiment
        </h2>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={submit}>
          <FieldGroup>
            <Field data-invalid={Boolean(shown("name"))}>
              <FieldLabel htmlFor="experiment-name">Name</FieldLabel>
              <Input
                aria-invalid={Boolean(shown("name"))}
                id="experiment-name"
                onChange={(event) => update({ name: event.target.value })}
                value={draft.name}
              />
              <FieldError>{shown("name")}</FieldError>
            </Field>
            <Field data-invalid={Boolean(shown("key"))}>
              <FieldLabel htmlFor="experiment-key">Key</FieldLabel>
              <Input
                aria-invalid={Boolean(shown("key"))}
                id="experiment-key"
                onChange={(event) => update({ key: event.target.value })}
                value={draft.key}
              />
              <FieldDescription>Unique per App and Environment.</FieldDescription>
              <FieldError>{shown("key")}</FieldError>
            </Field>
            <Field data-invalid={Boolean(shown("flagId"))}>
              <FieldLabel htmlFor="experiment-flag">Controlled Flag</FieldLabel>
              <Select
                onValueChange={(value) => update({ flagId: value ?? "" })}
                value={draft.flagId}
              >
                <SelectTrigger className="w-full" id="experiment-flag">
                  <SelectValue placeholder="Choose a Flag" />
                </SelectTrigger>
                <SelectContent>
                  {flags.map((flag) => (
                    <SelectItem key={flag.id} value={flag.id}>
                      {flag.key}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                The Run's Variant set is derived from this Flag's Variant catalog at Start.
              </FieldDescription>
              <FieldError>{shown("flagId")}</FieldError>
            </Field>
            <Field data-invalid={Boolean(shown("targetingKey"))}>
              <FieldLabel htmlFor="experiment-targeting-key">Targeting Key</FieldLabel>
              <Input
                aria-invalid={Boolean(shown("targetingKey"))}
                id="experiment-targeting-key"
                onChange={(event) => update({ targetingKey: event.target.value })}
                value={draft.targetingKey}
              />
              <FieldDescription>
                The Evaluation Context field traffic is bucketed on. Every Run inherits it.
              </FieldDescription>
              <FieldError>{shown("targetingKey")}</FieldError>
            </Field>
            <Field data-invalid={Boolean(shown("targetingKeyType"))}>
              <FieldLabel htmlFor="experiment-entity-type">Entity type</FieldLabel>
              <Input
                aria-invalid={Boolean(shown("targetingKeyType"))}
                id="experiment-entity-type"
                onChange={(event) => update({ targetingKeyType: event.target.value })}
                value={draft.targetingKeyType}
              />
              <FieldError>{shown("targetingKeyType")}</FieldError>
            </Field>
          </FieldGroup>
          {error ? (
            <Alert className="mt-4" variant="destructive">
              <AlertTitle>Experiment draft not created</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="mt-6 flex justify-end">
            <Button disabled={isSaving} type="submit">
              {isSaving ? <Spinner data-icon="inline-start" /> : null}
              {isSaving ? "Creating…" : "Create draft"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
