import type { PanelExperimentDetail } from "@splitch/control-plane-sdk/panel-experiments";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@splitch/ui/components/field";
import { Input } from "@splitch/ui/components/input";
import { Spinner } from "@splitch/ui/components/spinner";
import { Textarea } from "@splitch/ui/components/textarea";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { updateControlPanelExperiment } from "#lib/control-plane-experiment-functions";

export function ExperimentMetadataForm({
  appId,
  environmentId,
  experiment,
}: {
  appId: string;
  environmentId: string;
  experiment: PanelExperimentDetail;
}) {
  const router = useRouter();
  const [description, setDescription] = useState(experiment.description);
  const [owner, setOwner] = useState(experiment.owner);
  const [tags, setTags] = useState(experiment.tags.join(", "));
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("saving");
    try {
      const result = await updateControlPanelExperiment({
        data: {
          appId,
          environmentId,
          experimentId: experiment.id,
          patch: { description, owner, tags: splitTags(tags) },
        },
      });
      if (!result.ok) {
        setState("error");
        return;
      }
      setState("saved");
      await router.invalidate();
    } catch {
      setState("error");
    }
  }

  return (
    <form onSubmit={submit}>
      <Card>
        <CardHeader>
          <CardTitle>Experiment details</CardTitle>
          <CardDescription>
            Non-material edits apply in place without a Run boundary.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="experiment-description">Description</FieldLabel>
              <Textarea
                id="experiment-description"
                onChange={(event) => {
                  setDescription(event.target.value);
                  setState("idle");
                }}
                value={description}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="experiment-owner">Owner</FieldLabel>
              <Input
                id="experiment-owner"
                onChange={(event) => {
                  setOwner(event.target.value);
                  setState("idle");
                }}
                value={owner}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="experiment-tags">Tags</FieldLabel>
              <Input
                id="experiment-tags"
                onChange={(event) => {
                  setTags(event.target.value);
                  setState("idle");
                }}
                placeholder="checkout, acquisition"
                value={tags}
              />
              <FieldDescription>Comma-separated.</FieldDescription>
            </Field>
            {state === "error" ? (
              <Alert variant="destructive">
                <AlertTitle>Details not saved</AlertTitle>
                <AlertDescription>The Worker refused the edit. Try again.</AlertDescription>
              </Alert>
            ) : null}
            {state === "saved" ? (
              <Alert>
                <AlertTitle>Details saved</AlertTitle>
                <AlertDescription>No Experiment Run was opened or ended.</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-end">
          <Button disabled={state === "saving"} type="submit" variant="outline">
            {state === "saving" ? <Spinner data-icon="inline-start" /> : null}
            {state === "saving" ? "Saving…" : "Save details"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}

function splitTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}
