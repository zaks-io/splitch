import type { EnvironmentPolicy, EnvironmentPolicyLevel } from "@splitch/contracts";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Badge } from "@splitch/ui/components/badge";
import { Button } from "@splitch/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { updateControlPanelEnvironmentPolicy } from "#lib/settings/control-plane-settings-functions";
import { ENVIRONMENT_POLICY_LABELS } from "#lib/environments/environment-policy-labels";
import { refreshEnvironmentSettings } from "#lib/settings/settings-query";

interface EnvironmentPolicyEditorProps {
  appId: string;
  environmentId: string;
  initialPolicy: EnvironmentPolicy;
}

export function EnvironmentPolicyEditor({
  appId,
  environmentId,
  initialPolicy,
}: EnvironmentPolicyEditorProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initialPolicy);
  const [saved, setSaved] = useState(initialPolicy);
  const [error, setError] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  const isDirty = ENVIRONMENT_POLICY_LABELS.some(([key]) => draft[key] !== saved[key]);

  async function save() {
    setError(undefined);
    setIsSaving(true);
    try {
      const result = await updateControlPanelEnvironmentPolicy({
        data: { appId, environmentId, policy: draft },
      });
      if (result.ok) {
        setDraft(result.data.policy);
        setSaved(result.data.policy);
        try {
          const refreshed = await refreshEnvironmentSettings(queryClient, {
            appId,
            environmentId,
          });
          setDraft(refreshed.environment.policy);
          setSaved(refreshed.environment.policy);
        } catch {
          setError(
            "The Environment Policy was saved, but current settings could not be refreshed.",
          );
        }
      } else {
        setError(result.error.message);
      }
    } catch {
      setError("The Environment Policy was not saved. Worker state is unchanged.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Environment Policy</CardTitle>
        <CardDescription>
          Choose which change types commit freely and which require Confirmation.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="overflow-x-auto rounded-lg border border-border">
          <div className="grid min-w-160 grid-cols-[minmax(15rem,1fr)_repeat(3,8rem)] bg-muted/50 px-3 py-2 font-medium text-xs">
            <span>Change type</span>
            <span>Allow</span>
            <span>Confirm</span>
            <span>Approve</span>
          </div>
          {ENVIRONMENT_POLICY_LABELS.map(([key, label, note]) => (
            <PolicyRow
              key={key}
              label={label}
              name={key}
              note={note}
              onChange={(level) => setDraft((current) => ({ ...current, [key]: level }))}
              value={draft[key]}
            />
          ))}
          <div
            className="grid min-w-160 grid-cols-[minmax(15rem,1fr)_repeat(3,8rem)] items-center border-t px-3 py-3"
            data-testid="kill-switch-policy"
          >
            <span className="font-medium text-sm">Turn a Flag off (kill switch)</span>
            <span className="col-span-3">
              <Badge variant="outline">Never gated</Badge>
            </span>
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          Approve is visible for the future distinct-principal Review flow, but is not available
          yet.
        </p>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Environment Policy not saved</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter className="justify-end">
        <Button disabled={!isDirty || isSaving} onClick={save} type="button">
          {isSaving ? "Saving…" : "Save Policy"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function PolicyRow({
  label,
  name,
  note,
  onChange,
  value,
}: {
  label: string;
  name: string;
  note?: string;
  onChange: (level: EnvironmentPolicyLevel) => void;
  value: EnvironmentPolicyLevel;
}) {
  return (
    <fieldset className="grid min-w-160 grid-cols-[minmax(15rem,1fr)_repeat(3,8rem)] items-center border-t px-3 py-3">
      <legend className="sr-only">{label}</legend>
      <span className="font-medium text-sm">
        {label}
        {note ? (
          <span className="mt-1 block font-normal text-muted-foreground text-xs">{note}</span>
        ) : null}
      </span>
      {(["allow", "confirm"] as const).map((level) => (
        <label className="flex items-center gap-2 text-sm capitalize" key={level}>
          <input
            checked={value === level}
            name={name}
            onChange={() => onChange(level)}
            type="radio"
            value={level}
          />
          <span className="sr-only">{level}</span>
        </label>
      ))}
      <label className="flex items-center gap-2 text-muted-foreground text-sm">
        <input aria-label={`${label}: Approve coming soon`} disabled name={name} type="radio" />
        <span>Coming soon</span>
      </label>
    </fieldset>
  );
}
