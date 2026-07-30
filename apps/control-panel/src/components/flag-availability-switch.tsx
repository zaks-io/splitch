import { Switch } from "@splitch/ui/components/switch";
import type { FlagDetailView } from "#lib/flag-detail-view";
import { availabilityIntent } from "#lib/flag-edit-intent";
import type { FlagEditing } from "#lib/use-flag-editing";

/**
 * Per-Environment availability for one catalog Variant.
 *
 * It sits on the catalog row because that is exactly where the "defined vs
 * available here" confusion happens: the Variant exists at App level, and this
 * toggle only changes whether this one Environment may serve it (ADR-0028).
 *
 * The switch reflects the Worker's last confirmed state and never moves on its
 * own. A rejected change leaves it exactly where it was, because the value comes
 * from the loader and not from a click.
 */
export function FlagAvailabilitySwitch({
  ariaLabel,
  checked,
  editing,
  variantName,
  view,
}: {
  ariaLabel: string;
  checked: boolean;
  editing: FlagEditing;
  variantName: string;
  view: FlagDetailView;
}) {
  return (
    <Switch
      aria-label={ariaLabel}
      checked={checked}
      data-availability-input={variantName}
      disabled={editing.busy}
      onCheckedChange={(next) =>
        void editing.submit(availabilityIntent(view, variantName, next === true))
      }
      size="sm"
    />
  );
}
