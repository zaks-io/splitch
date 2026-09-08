import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@splitch/ui/components/dialog";
import { Field, FieldLabel } from "@splitch/ui/components/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@splitch/ui/components/select";
import { Spinner } from "@splitch/ui/components/spinner";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { loadControlPanelConclusionTarget } from "#lib/experiments/control-plane-conclusion-functions";
import type { ConclusionScope } from "#lib/experiments/experiment-conclusion-model";
import { ExperimentConclusionForm } from "./experiment-conclusion-form";

export function ExperimentConclusionDialog({
  scope,
  environments,
  variants,
  expectedResultToken,
  dataWatermark,
  onClose,
}: {
  scope: ConclusionScope;
  environments: readonly { environmentId: string; env: string }[];
  variants: readonly string[];
  expectedResultToken: string;
  dataWatermark: string;
  onClose: () => void;
}) {
  const [targetEnvironmentId, setTargetEnvironmentId] = useState(scope.environmentId);
  const [locked, setLocked] = useState(false);
  const [evidence] = useState(() => ({ expectedResultToken, dataWatermark }));
  const target = useQuery({
    queryKey: ["conclusion-target", scope.appId, scope.flagId, targetEnvironmentId],
    queryFn: async () => {
      const result = await loadControlPanelConclusionTarget({
        data: {
          appId: scope.appId,
          environmentId: targetEnvironmentId,
          flagId: scope.flagId,
        },
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const targetEnvironment = environments.find(
    (environment) => environment.environmentId === targetEnvironmentId,
  );
  if (!targetEnvironment) throw new Error("Conclusion target Environment is missing from the App");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked) onClose();
      }}
    >
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
        showCloseButton={!locked}
      >
        <DialogHeader>
          <DialogTitle>Conclude Run</DialogTitle>
          <DialogDescription>
            Choose a Variant and review the configuration to apply. Confirming Ends this Run,
            records the decision, and requests Promotion.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="conclusion-environment">Target Environment</FieldLabel>
          <Select
            value={targetEnvironmentId}
            onValueChange={(value) => {
              if (value) setTargetEnvironmentId(value);
            }}
            disabled={locked}
          >
            <SelectTrigger id="conclusion-environment">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {environments.map((environment) => (
                  <SelectItem key={environment.environmentId} value={environment.environmentId}>
                    {environment.env}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        {target.isFetching ? (
          <Spinner aria-label="Loading target configuration" />
        ) : target.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Target configuration unavailable</AlertTitle>
            <AlertDescription>
              {target.error.message}
              <Button variant="outline" onClick={() => void target.refetch()}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : target.data ? (
          <ExperimentConclusionForm
            key={`${targetEnvironmentId}:${target.data.version}`}
            scope={scope}
            target={target.data}
            targetEnv={targetEnvironment.env}
            variants={variants}
            expectedResultToken={evidence.expectedResultToken}
            dataWatermark={evidence.dataWatermark}
            onClose={onClose}
            onLock={setLocked}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
