import { Button } from "@splitch/ui/components/button";
import { Input } from "@splitch/ui/components/input";
import { useState } from "react";
import type { FlagDetailView } from "#lib/flags/flag-detail-view";
import { baselineRolloutIntent } from "#lib/flags/flag-edit-intent";
import type { FlagEditing } from "#lib/flags/use-flag-editing";

/**
 * The baseline percentage for traffic that matches no Targeting Rule.
 *
 * The draft in this input is form state, not a mirror of the Configuration: it is
 * never rendered as the served value, and only the loader's re-read after a 200
 * changes what the screen reports. The bucketing salt is absent on purpose — it
 * is minted server-side once and never regenerated, so an operator neither sees
 * nor sets it.
 */
export function FlagBaselineRolloutEditor({
  editing,
  view,
}: {
  editing: FlagEditing;
  view: FlagDetailView;
}) {
  const [draft, setDraft] = useState("");

  if (!view.configured) {
    return <p className="text-muted-foreground text-sm leading-6">Nothing is served here yet.</p>;
  }

  const parsed = Number(draft);
  const valid = draft.trim() !== "" && Number.isFinite(parsed) && parsed >= 0 && parsed <= 100;

  return (
    <div className="grid gap-3" data-flag-baseline-rollout="true">
      <p className="text-foreground text-sm leading-6" data-baseline-current="true">
        {view.baselineRolloutPercentage === null
          ? "No baseline percentage rollout."
          : `${view.baselineRolloutPercentage}% of traffic`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="baseline rollout percentage"
          className="w-28"
          data-baseline-input="true"
          disabled={editing.busy}
          inputMode="decimal"
          onChange={(event) => setDraft(event.target.value)}
          placeholder="0-100"
          value={draft}
        />
        <Button
          data-baseline-save="true"
          disabled={editing.busy || !valid}
          onClick={() => void editing.submit(baselineRolloutIntent(parsed))}
          type="button"
        >
          Set baseline
        </Button>
        <Button
          data-baseline-clear="true"
          disabled={editing.busy || view.baselineRolloutPercentage === null}
          onClick={() => void editing.submit(baselineRolloutIntent(null))}
          type="button"
          variant="outline"
        >
          Clear
        </Button>
      </div>
    </div>
  );
}
