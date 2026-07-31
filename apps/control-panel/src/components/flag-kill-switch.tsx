import { Badge } from "@splitch/ui/components/badge";
import { Switch } from "@splitch/ui/components/switch";
import type { FlagDetailView } from "#lib/flag-detail-view";
import { killSwitchIntent } from "#lib/flag-edit-intent";
import type { FlagEditing } from "#lib/use-flag-editing";

/**
 * Incident control. Always present, never gated by an Experiment.
 *
 * `isLocked` returns false for `kill-switch` by construction and this component
 * never consults it: an operator must be able to turn a Flag off during an
 * incident even while an Experiment runs and even in an Environment whose Policy
 * confirms everything else (ADR-0029). Turning it OFF is ungated at the Worker
 * too, so the two agree rather than the panel pretending.
 */
export function FlagKillSwitch({ editing, view }: { editing: FlagEditing; view: FlagDetailView }) {
  if (!view.configured) {
    return (
      <p className="text-muted-foreground text-sm leading-6">
        No Flag Configuration in this Environment yet, so nothing is served here.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3" data-flag-kill-switch="true">
      <Switch
        aria-label={`serving ${view.key} in ${view.env}`}
        checked={view.enabled}
        data-kill-switch-input="true"
        disabled={editing.busy}
        onCheckedChange={(next) => void editing.submit(killSwitchIntent(next === true))}
      />
      <Badge
        variant={view.enabled ? "default" : "secondary"}
        data-kill-switch-state={view.enabled ? "enabled" : "disabled"}
      >
        {view.enabled ? "Enabled" : "Disabled"}
      </Badge>
      <span className="text-muted-foreground text-xs leading-5">
        Never locked, so this Flag can always be turned off. Turning it off applies immediately.
      </span>
    </div>
  );
}
