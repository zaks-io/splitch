import type { ExperimentDecisionGate } from "@splitch/contracts";
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
  gate,
  runStatus,
}: {
  gate: ExperimentDecisionGate;
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
          <p className="mt-1 max-w-prose text-muted-foreground text-sm">
            {gate.shipAllowed
              ? "Every readiness check passed. Concluding this Run is allowed."
              : "Concluding this Run is blocked until the failing checks below clear."}
          </p>
        </div>
        <Button disabled={!gate.shipAllowed} type="button">
          Conclude and promote winner
        </Button>
      </div>

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
              <span className="text-muted-foreground"> — {check.detail}</span>
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

function CheckMark({ status }: { status: "pass" | "fail" | "not_applicable" }) {
  const label = status === "pass" ? "Passed" : status === "fail" ? "Failed" : "Not applicable";
  const glyph = status === "pass" ? "✓" : status === "fail" ? "✕" : "–";
  const tone =
    status === "pass"
      ? "text-arm-treatment-foreground"
      : status === "fail"
        ? "text-destructive"
        : "text-muted-foreground";
  return (
    <span aria-label={label} className={`font-mono text-sm leading-5 ${tone}`} role="img">
      {glyph}
    </span>
  );
}
