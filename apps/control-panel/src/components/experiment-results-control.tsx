import type { FrozenControlIdentity } from "@splitch/contracts";

/**
 * How the Results tab talks about the Run's Control arm.
 *
 * When the frozen Control cannot be resolved there is no baseline arm: every
 * caller gets `null` rather than a plausible-looking name, so no row can be
 * coloured or labelled as the baseline on a guess.
 */

export function baselineVariant(control: FrozenControlIdentity): string | null {
  if (control.state === "unresolvable") return null;
  return control.state === "disagreement" ? control.analysisVariant : control.variant;
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
          are written at Start and should match. Because they do not, every lift here is measured
          against{" "}
          <code className="font-mono text-foreground text-xs">{control.analysisVariant}</code> and
          not against the Run&apos;s own Control.
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
  const reason =
    control.reason === "absent_from_frozen_variant_set"
      ? "it is absent from the Variant set this Run froze"
      : "the frozen Variant set could not be read";
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
          The numbers below are still shown, because they are what this Run measured. What cannot be
          shown is which arm they are measured against.
        </p>
      ) : null}
      <p className="mt-2 max-w-prose text-muted-foreground text-sm leading-6">
        No arm is marked as the baseline and the ship decision is blocked. Start a new Run to get a
        Control that is frozen and validated.
      </p>
    </div>
  );
}
