import type { PatchExperimentRequest } from "@splitch/contracts";
import { useState } from "react";
import { controlPlaneErrorMessage } from "./control-plane-error-message";
import { updateControlPanelExperiment } from "./control-plane-experiment-functions";
import { useExperimentDetailRefresh } from "./use-experiment-detail-refresh";

/**
 * Persist one wizard step onto the real `draft` Experiment.
 *
 * Each step writes before it advances, so the draft on the server is always what
 * the operator last saw and leaving mid-flow loses nothing. The Experiment is
 * re-read on success rather than patched locally: the Worker owns the row and
 * ADR-0023 forbids the Panel from rendering a state the Control Plane has not
 * confirmed.
 */
export function useExperimentDraftPatch(
  scope: { appId: string; environmentId: string },
  experimentId: string,
) {
  const refresh = useExperimentDetailRefresh(scope, experimentId);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function save(patch: PatchExperimentRequest, onSaved: () => void | Promise<void>) {
    setIsSaving(true);
    setError(undefined);
    try {
      const result = await updateControlPanelExperiment({
        data: { ...scope, experimentId, patch },
      });
      if (!result.ok) {
        setError(controlPlaneErrorMessage(result.error));
        return;
      }
      await refresh();
      await onSaved();
    } catch {
      setError("The Control Plane could not save this step. Try again.");
    } finally {
      setIsSaving(false);
    }
  }

  return { error, isSaving, save };
}
