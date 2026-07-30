import type { FrozenControlIdentity } from "@splitch/contracts";

/**
 * How the Results tab talks about the Run's Control arm.
 *
 * When the frozen Control cannot be resolved there is no baseline arm: every
 * caller gets `null` rather than a plausible-looking name, so no row can be
 * coloured or labelled as the baseline on a guess.
 */

export function baselineVariant(control: FrozenControlIdentity): string | null {
  return control.state === "frozen" ? control.variant : null;
}

export function baselineLabel(control: FrozenControlIdentity): string {
  return control.state === "frozen" ? control.variant : "an unidentified Control";
}

export function ExperimentResultsControlIntegrity({ control }: { control: FrozenControlIdentity }) {
  if (control.state === "frozen") return null;
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-5" role="alert">
      <h3 className="font-semibold text-base text-foreground">Control arm cannot be identified</h3>
      <p className="mt-2 max-w-prose text-muted-foreground text-sm leading-6">
        This Run froze{" "}
        <code className="font-mono text-foreground text-xs">{control.variantId}</code> as its
        Control, but that Variant is not in the Variant set the same Run froze (
        {control.reason === "absent_from_frozen_variant_set"
          ? "it is absent from that set"
          : "the frozen set could not be read"}
        ). Runs created before the Control was frozen on the Run were backfilled from the
        Experiment's default Variant, which the Run itself may never have carried.
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
      <p className="mt-2 max-w-prose text-muted-foreground text-sm leading-6">
        The numbers below are still shown, because they are what this Run measured. What cannot be
        shown is which arm they are measured against, so no arm is marked as the baseline and the
        ship decision is blocked. Start a new Run to get a Control that is frozen and validated.
      </p>
    </div>
  );
}
