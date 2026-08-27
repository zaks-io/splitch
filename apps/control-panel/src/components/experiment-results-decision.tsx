import type {
  DecisionGateCheck,
  ExperimentDecisionGate,
  FrozenControlIdentity,
  GuardrailResult,
} from "@splitch/contracts";
import { Button } from "@splitch/ui/components/button";

/**
 * The ship-decision gate, rendered exactly as the Worker computed it.
 *
 * Nothing here evaluates a threshold. The Panel receives `gate` from
 * control-plane-api and renders its verdict verbatim, so the Panel, the CLI and
 * MCP cannot disagree about whether an Experiment may be concluded (ADR-0030).
 * There is deliberately no escape hatch: a bypass control would turn the
 * enforced contract back into an advisory one.
 */

export function ExperimentResultsDecision({
  control,
  gate,
  guardrails,
  runStatus,
}: {
  control: FrozenControlIdentity;
  gate: ExperimentDecisionGate;
  guardrails: readonly GuardrailResult[];
  runStatus: "running" | "ended";
}) {
  const blocking = gate.checks.filter((check) => check.status === "fail");
  return (
    <section
      aria-labelledby="results-decision-heading"
      className="rounded-lg border border-border bg-card p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold text-base text-foreground" id="results-decision-heading">
            Ship decision
          </h3>
          <GateSummary gate={gate} />
        </div>
        <ConcludeAction shipAllowed={gate.shipAllowed} />
      </div>

      <GuardrailAdvisory guardrails={guardrails} />

      {gate.shipAllowed ? null : (
        <div
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-4"
          data-testid="ship-blocked"
        >
          <p className="font-medium text-destructive text-sm">
            Blocked by {blocking.length} failing {blocking.length === 1 ? "check" : "checks"}
          </p>
          {/* Titles only. Each one is spelled out in full in the check list below. */}
          <ul className="mt-2 grid gap-1">
            {blocking.map((check) => (
              <li className="font-medium text-foreground text-sm" key={check.id}>
                {check.title}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ul className="mt-4 grid gap-2">
        {gate.checks.map((check) => (
          <li className="flex items-start gap-2 text-sm" key={check.id}>
            <CheckMark status={check.status} />
            <span>
              <span className="font-medium text-foreground">{check.title}</span>
              <span className="text-muted-foreground">
                {" — "}
                <CheckDetail check={check} control={control} />
              </span>
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-4 border-border border-t pt-3 text-muted-foreground text-xs">
        Enforced by {gate.enforcedBy}. The Panel renders this verdict and never recomputes it, so
        the API, the CLI and the Panel refuse the same decisions.
        {runStatus === "running"
          ? " Reading these numbers mid-Run is safe: the interval is an always-valid confidence sequence, so peeking does not inflate the false-positive rate."
          : ""}
      </p>
    </section>
  );
}

function CheckDetail({
  check,
  control,
}: {
  check: DecisionGateCheck;
  control: FrozenControlIdentity;
}) {
  if (check.id !== "control_identity" || control.state !== "unresolvable") {
    return check.detail;
  }
  const recordedValue = `"${control.variantId}"`;
  const recordedValueIndex = check.detail.indexOf(recordedValue);
  if (recordedValueIndex === -1) {
    throw new Error("Unresolvable Control detail omitted its recorded value");
  }
  return (
    <>
      {check.detail.slice(0, recordedValueIndex)}&quot;
      <code className="font-mono text-foreground text-xs">{control.variantId}</code>&quot;
      {check.detail.slice(recordedValueIndex + recordedValue.length)}
    </>
  );
}

/**
 * "Every readiness check passed" claims a pass for checks that only reported
 * not-applicable. Count what was actually assessed.
 */
function GateSummary({ gate }: { gate: ExperimentDecisionGate }) {
  const passed = gate.checks.filter((check) => check.status === "pass").length;
  const noun = gate.checks.length === 1 ? "check" : "checks";
  return (
    <p className="mt-1 max-w-prose text-muted-foreground text-sm">
      {gate.shipAllowed
        ? `No blocking check. ${passed} of ${gate.checks.length} readiness ${noun} passed, and the rest do not apply to this Run.`
        : "Concluding this Run is blocked until the failing checks below clear."}
    </p>
  );
}

/**
 * Always disabled. The conclude/promote mutation does not exist yet (SPL-158),
 * and an enabled control that silently does nothing is a lie about what the
 * Panel can do (ADR-0036).
 */
function ConcludeAction({ shipAllowed }: { shipAllowed: boolean }) {
  return (
    <div className="grid justify-items-end gap-1">
      <Button disabled type="button">
        Conclude and apply winner
      </Button>
      <p className="text-muted-foreground text-xs">
        {shipAllowed
          ? "Not wired up yet: concluding a Run ships in SPL-158."
          : "Blocked by the checks below, and not wired up yet (SPL-158)."}
      </p>
    </div>
  );
}

/**
 * Guardrails deliberately do not gate, so a breach can sit beside a clean gate.
 * Naming it here is the difference between a decision and an accident.
 */
function GuardrailAdvisory({ guardrails }: { guardrails: readonly GuardrailResult[] }) {
  const breached = guardrails.filter((guardrail) => guardrail.is_breached === true);
  if (breached.length === 0) return null;
  return (
    <p
      className="mt-4 rounded-md border border-warning/40 bg-warning-muted p-3 text-sm text-warning-foreground"
      data-testid="ship-guardrail-advisory"
    >
      {breached.length} Guardrail {breached.length === 1 ? "Metric is" : "Metrics are"} breached on
      this Run: {breached.map((guardrail) => guardrail.metric_id).join(", ")}. A Guardrail breach
      does not block the gate, so this decision would ship a known regression.
    </p>
  );
}

function CheckMark({ status }: { status: "pass" | "fail" | "not_applicable" }) {
  const label = status === "pass" ? "Passed" : status === "fail" ? "Failed" : "Not applicable";
  const glyph = status === "pass" ? "✓" : status === "fail" ? "✕" : "–";
  const tone =
    status === "pass"
      ? "text-success"
      : status === "fail"
        ? "text-destructive"
        : "text-muted-foreground";
  return (
    <span aria-label={label} className={`font-mono text-sm leading-5 ${tone}`} role="img">
      {glyph}
    </span>
  );
}
