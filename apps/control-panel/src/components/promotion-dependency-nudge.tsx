import { Button } from "@splitch/ui/components/button";
import type { PromotionDependency } from "#lib/promotion-selection";

/**
 * The dependency nudge: offer in the panel, block at the Worker (ADR-0028/0036).
 *
 * A promoted Targeting Rule that routes to a Variant the target cannot serve is a
 * dangling reference. This offers the one-click fix and says which rule needs it —
 * and it never applies itself. Auto-ticking an availability row would change what
 * gets promoted without the operator seeing it, which is exactly the silent side
 * effect this screen exists to prevent. Submitting past the nudge is allowed; the
 * Worker then refuses with a structured error naming the Variant.
 */
export function PromotionDependencyNudge({
  dependencies,
  disabled,
  onApply,
}: {
  dependencies: readonly PromotionDependency[];
  disabled: boolean;
  onApply: (rowId: string) => void;
}) {
  if (dependencies.length === 0) return null;

  return (
    <div
      className="grid gap-3 rounded-lg border border-amber-500/40 bg-amber-50/60 p-4 dark:bg-amber-950/20"
      data-promotion-nudges="true"
      role="status"
    >
      <p className="font-medium text-foreground text-sm">
        {dependencies.length === 1
          ? "One promoted rule points at a Variant this Environment cannot serve"
          : `${dependencies.length} promoted rules point at Variants this Environment cannot serve`}
      </p>
      <ul className="grid gap-3">
        {dependencies.map((dependency) => (
          <li
            className="flex flex-wrap items-center justify-between gap-3"
            data-promotion-nudge={dependency.variantName}
            data-promotion-nudge-remedy={dependency.remedy}
            key={dependency.variantName}
          >
            <p className="text-muted-foreground text-sm leading-6">
              <span className="font-mono text-foreground">{dependency.variantName}</span> is not
              available here.{" "}
              <span data-promotion-nudge-reason="true">
                Added because rule {dependency.reason} needs it.
              </span>
            </p>
            <NudgeAction dependency={dependency} disabled={disabled} onApply={onApply} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function NudgeAction({
  dependency,
  disabled,
  onApply,
}: {
  dependency: PromotionDependency;
  disabled: boolean;
  onApply: (rowId: string) => void;
}) {
  if (dependency.remedy === "none" || dependency.rowId === null) {
    return (
      <p className="text-amber-700 text-xs leading-5 dark:text-amber-400">
        No row here can fix this: the Variant is unavailable in both Environments. Make it available
        first, or leave Targeting unticked.
      </p>
    );
  }
  return (
    <Button
      data-promotion-nudge-apply={dependency.variantName}
      disabled={disabled}
      onClick={() => onApply(dependency.rowId as string)}
      size="sm"
      type="button"
      variant="outline"
    >
      {dependency.remedy === "tick"
        ? `Also make ${dependency.variantName} available here`
        : `Keep ${dependency.variantName} available here`}
    </Button>
  );
}
