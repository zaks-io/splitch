import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import { Input } from "@splitch/ui/components/input";
import { Label } from "@splitch/ui/components/label";
import { useState } from "react";
import { verifyControlPanelFlag } from "#lib/control-plane-verify-functions";
import {
  explainVerifyResult,
  type PanelVerifyOutcome,
  VERIFY_IS_NOT_AN_EXPOSURE,
} from "#lib/panel-verify";
import { VERIFY_PARITY } from "#lib/parity-hints";

type PanelState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "result"; outcome: PanelVerifyOutcome }
  | { kind: "unreachable"; message: string };

/**
 * Step 5 of the visual quickstart: prove the Flag resolves, for a key you choose,
 * without recording an Exposure.
 *
 * A failure renders as a destructive Alert with no resolved-Variant heading; a
 * success renders as a success Alert. The two shapes are deliberately not
 * interchangeable, because a verify that failed must never be readable as a
 * green check (ADR-0036).
 */
export function FlagVerifyPanel({
  appId,
  environmentId,
  flagKey,
}: {
  appId: string;
  environmentId: string;
  flagKey: string;
}) {
  const [targetingKey, setTargetingKey] = useState("user-1");
  const [state, setState] = useState<PanelState>({ kind: "idle" });

  async function runVerify() {
    setState({ kind: "running" });
    try {
      const result = await verifyControlPanelFlag({
        data: { appId, environmentId, flagKey, targetingKey },
      });
      setState(
        result.ok
          ? { kind: "result", outcome: result.data }
          : { kind: "unreachable", message: `${result.error.code}: ${result.error.message}` },
      );
    } catch (error) {
      setState({
        kind: "unreachable",
        message: error instanceof Error ? error.message : "The verify request did not complete.",
      });
    }
  }

  return (
    <div className="grid gap-3" data-testid="verify-panel">
      <div className="grid gap-2">
        <Label htmlFor="verify-targeting-key">Test this Flag for a targeting key</Label>
        <div className="flex gap-2">
          <Input
            id="verify-targeting-key"
            onChange={(event) => setTargetingKey(event.target.value)}
            value={targetingKey}
          />
          <Button
            disabled={state.kind === "running" || targetingKey.trim().length === 0}
            onClick={runVerify}
            type="button"
            variant="outline"
          >
            {state.kind === "running" ? "Testing…" : "Test"}
          </Button>
        </div>
      </div>

      <VerifyOutcome state={state} />

      <p className="text-muted-foreground text-xs leading-5">
        {VERIFY_IS_NOT_AN_EXPOSURE} The same check runs as{" "}
        <code>
          {VERIFY_PARITY.cli} {flagKey} --targeting-key {targetingKey || "<key>"}
        </code>
        , or <code>{VERIFY_PARITY.mcp}</code> for an agent.
      </p>
    </div>
  );
}

function VerifyOutcome({ state }: { state: PanelState }) {
  if (state.kind === "unreachable") {
    return (
      <Alert data-testid="verify-error" variant="destructive">
        <AlertTitle>Verify could not run</AlertTitle>
        <AlertDescription>
          {state.message} Nothing was resolved — this is not a result for your Flag.
        </AlertDescription>
      </Alert>
    );
  }

  if (state.kind !== "result") {
    return null;
  }

  const explanation = explainVerifyResult(state.outcome);
  if (explanation.tone === "failed") {
    return (
      <Alert data-testid="verify-error" variant="destructive">
        <AlertTitle>{explanation.headline}</AlertTitle>
        <AlertDescription>{explanation.detail}</AlertDescription>
      </Alert>
    );
  }

  const degraded = explanation.tone === "degraded";
  return (
    <Alert
      className={degraded ? "border-warning bg-warning-muted text-warning-foreground" : undefined}
      data-testid={degraded ? "verify-degraded" : "verify-success"}
    >
      <AlertTitle>{explanation.headline}</AlertTitle>
      <AlertDescription>
        {explanation.detail} Value: <code>{state.outcome.valueJson}</code>
      </AlertDescription>
    </Alert>
  );
}
