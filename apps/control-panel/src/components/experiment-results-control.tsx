import { type FrozenControlIdentity, unresolvableControlReasonMessages } from "@splitch/contracts";

/**
 * How the Results tab talks about the Run's Control arm.
 *
 * Analysis always names the Control used to measure lift. Resolving the Run's
 * own frozen Control is a separate question: an unresolvable Run must not label
 * an arm as its baseline from the Analysis Control alone.
 */

export function analysisControlVariant(control: FrozenControlIdentity): string {
  return control.state === "frozen" ? control.variant : control.analysisVariant;
}

export function baselineVariant(control: FrozenControlIdentity): string | null {
  if (control.state === "unresolvable") return null;
  return analysisControlVariant(control);
}

export function ExperimentResultsControlIntegrity({
  control,
  resultsRendered,
}: {
  control: FrozenControlIdentity;
  resultsRendered: boolean;
}) {
  if (control.state === "frozen") return null;
  if (control.state === "disagreement") {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-5" role="alert">
        <h3 className="font-semibold text-base text-foreground">
          Analysis Control disagrees with the Run
        </h3>
        <p className="mt-2 max-w-prose text-muted-foreground text-sm leading-6">
          This Run froze{" "}
          <code className="font-mono text-foreground text-xs">{control.variant}</code> as its
          Control, but the Run Snapshot written to the analytics store at Start recorded{" "}
          <code className="font-mono text-foreground text-xs">{control.analysisVariant}</code>. Both
          are written at Start and should match.{" "}
          {resultsRendered ? (
            <>
              Because they do not, every lift below is measured against{" "}
              <code className="font-mono text-foreground text-xs">{control.analysisVariant}</code>{" "}
              and not against the Run&apos;s own Control.
            </>
          ) : (
            <>
              Because they do not, results for this Run will be measured against{" "}
              <code className="font-mono text-foreground text-xs">{control.analysisVariant}</code>{" "}
              and not against the Run&apos;s own Control when they arrive.
            </>
          )}
        </p>
        <p className="mt-2 max-w-prose text-muted-foreground text-sm leading-6">
          The Run Snapshot cannot be rewritten, so this Run cannot be corrected. Start a new Run to
          get a Control that agrees across both stores.
        </p>
        {resultsRendered ? (
          <p className="mt-2 max-w-prose text-muted-foreground text-sm leading-6">
            The numbers below remain visible for diagnosis.
          </p>
        ) : null}
      </div>
    );
  }
  const reason = unresolvableControlReasonMessages[control.reason];
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-5" role="alert">
      <h3 className="font-semibold text-base text-foreground">Control arm cannot be identified</h3>
      <p className="mt-2 max-w-prose text-muted-foreground text-sm leading-6">
        This Run&apos;s frozen Control cannot be identified because {reason}. Runs created before
        the Control was frozen on the Run were backfilled from the Experiment&apos;s default
        Variant, which the Run itself may never have carried.
      </p>
      {control.frozenVariantNames.length > 0 ? (
        <p className="mt-2 max-w-prose text-muted-foreground text-sm leading-6">
          The Run froze{" "}
          <span className="font-mono text-foreground text-xs">
            {control.frozenVariantNames.join(", ")}
          </span>
          .
        </p>
      ) : null}
      {resultsRendered ? (
        <p className="mt-2 max-w-prose text-muted-foreground text-sm leading-6">
          The Run Snapshot written to the analytics store at Start recorded{" "}
          <code className="font-mono text-foreground text-xs">{control.analysisVariant}</code> as
          the Analysis Control. Every lift below is measured against that Variant.
        </p>
      ) : null}
      <p className="mt-2 max-w-prose text-muted-foreground text-sm leading-6">
        {resultsRendered
          ? "The Run Snapshot names the Analysis Control, but it cannot establish the Run's own frozen Control. No arm below is marked as the baseline on the Snapshot alone, and the ship decision is blocked. Start a new Run to get a Control that is frozen and validated."
          : "This Run cannot produce a ship decision. Start a new Run to get a Control that is frozen and validated."}
      </p>
    </div>
  );
}
