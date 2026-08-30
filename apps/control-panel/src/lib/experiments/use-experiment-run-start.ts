import { useState } from "react";
import { controlPlaneErrorMessage } from "#lib/shared/control-plane-error-message";
import { stageAndStartControlPanelExperimentRun } from "#lib/experiments/control-plane-experiment-functions";
import {
  buildRunStartInput,
  type RunHorizonChoice,
} from "#lib/experiments/experiment-run-draft-model";
import { useExperimentDetailRefresh } from "#lib/experiments/use-experiment-detail-refresh";

/**
 * The ONE way the Panel opens an Experiment Run.
 *
 * Run 1 (Experiment creation) and every later Run are the same operation on the
 * same draft columns, so they go through this hook and therefore through the one
 * `stageAndStartControlPanelExperimentRun` server function. A second start
 * pathway would be a second place for the Environment Policy gate, the
 * idempotency key, and the draft staging to drift — grep for
 * `stageAndStartControlPanelExperimentRun` and this module is the only hit
 * outside its own definition.
 */

export interface RunStartDraft {
  activationMetricId: string;
  allocation: Record<string, number>;
  horizon: RunHorizonChoice;
  reason: string;
  sampleSize: string;
  salt: string;
  targetingKey: string;
  targetingKeyType: string;
  /** Raw JSON text from the form; parsed here so a parse failure is reported, not swallowed. */
  targetingRules: string;
}

export function useExperimentRunStart({
  appId,
  environmentId,
  experimentId,
  onStarted,
}: {
  appId: string;
  environmentId: string;
  experimentId: string;
  /**
   * Called only once a Run actually exists. A Start whose Approval Request did
   * not apply is answered by the Control Plane as a REFUSAL, not as an ok
   * response carrying a pending request, so it lands on `error` below and never
   * reaches here — the caller's surface stays open on the refusal rather than
   * reporting a Run that was never opened (ADR-0036).
   */
  onStarted: () => void;
}) {
  const refresh = useExperimentDetailRefresh({ appId, environmentId }, experimentId);
  // Minted once per mounted form rather than per attempt: a key regenerated on
  // retry would give the Control Plane no way to recognize a replay of the same
  // Start, and a gated Start would open a second Approval Request.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string>();

  async function start(draft: RunStartDraft) {
    // Parsed before the request, and outside the catch below: a local syntax
    // error blamed on the Control Plane would offer "try again" as a remedy the
    // operator cannot act on (ADR-0036).
    let targetingRules: unknown[];
    try {
      targetingRules = JSON.parse(draft.targetingRules) as unknown[];
    } catch {
      setError("The Targeting rules are not valid JSON. Fix them before Starting the Run.");
      return;
    }
    setIsStarting(true);
    setError(undefined);
    try {
      const result = await stageAndStartControlPanelExperimentRun({
        data: buildRunStartInput({
          ...draft,
          appId,
          environmentId,
          experimentId,
          idempotencyKey,
          targetingRules,
        }),
      });
      if (!result.ok) {
        setError(controlPlaneErrorMessage(result.error));
        return;
      }
      await refresh();
      onStarted();
    } catch {
      setError("The Control Plane could not Start this Experiment Run. Try again.");
    } finally {
      setIsStarting(false);
    }
  }

  return { error, isStarting, start };
}
