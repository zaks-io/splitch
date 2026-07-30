import { Card, CardContent, CardHeader, CardTitle } from "@splitch/ui/components/card";
import { type FlagDetailView, isLocked } from "#lib/flag-detail-view";
import type { FlagEditing } from "#lib/use-flag-editing";
import { FlagBaselineRolloutEditor } from "./flag-baseline-rollout-editor";
import { FlagDetailLock } from "./flag-detail-lock";
import { FlagKillSwitch } from "./flag-kill-switch";
import { FlagTargetingRulesEditor } from "./flag-targeting-rules-editor";
import { FlagTargetingSummary } from "./flag-targeting-summary";

/**
 * The PRIMARY content of the Flag detail screen: what this one Environment serves.
 *
 * It leads because the URL grain is an Environment and that is where flag work
 * happens (screen-inventory.md). Every value shown is this Environment's, so an
 * unconfigured Flag says so outright rather than borrowing another Environment's
 * numbers.
 */
export function FlagDetailEnvConfig({
  editing,
  view,
}: {
  editing: FlagEditing;
  view: FlagDetailView;
}) {
  const experiment = view.controllingExperiment;

  return (
    <Card data-flag-env-config={view.env}>
      <CardHeader className="border-border border-b py-4">
        <CardTitle className="text-base">
          Configuration in <span className="font-mono">{view.env}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-8 pt-6">
        <section className="grid gap-2" aria-label="Kill switch">
          <FieldLabel>Kill switch</FieldLabel>
          <FlagKillSwitch editing={editing} view={view} />
        </section>

        <section className="grid gap-3" aria-label="Available Variants">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <FieldLabel>Available Variants</FieldLabel>
            {isLocked(view, "availability") && experiment ? (
              <FlagDetailLock experimentName={experiment.name} />
            ) : null}
          </div>
          {renderAvailability(view)}
        </section>

        <section className="grid gap-3" aria-label="Targeting Rules">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <FieldLabel>Targeting Rules</FieldLabel>
            {isLocked(view, "targeting") && experiment ? (
              <FlagDetailLock experimentName={experiment.name} />
            ) : null}
          </div>
          {/*
            Locked means ABSENT, not disabled. A running Experiment owns targeting
            in this Environment, and a frozen-but-present control is a control that
            can still misfire; the read-only summary carries the state instead.
          */}
          {renderTargeting(editing, view)}
        </section>

        <section className="grid gap-2" aria-label="Baseline rollout">
          <FieldLabel>Baseline rollout</FieldLabel>
          {/*
            Not locked by an Experiment: the baseline is not part of the frozen Run
            configuration, so freezing it here would invent a lock the Worker does
            not enforce.
          */}
          <FlagBaselineRolloutEditor editing={editing} view={view} />
        </section>
      </CardContent>
    </Card>
  );
}

/**
 * There is nothing to edit until a Configuration exists in this Environment, so
 * the editor is absent rather than offered against a resource the Worker would
 * refuse to write.
 */
function renderTargeting(editing: FlagEditing, view: FlagDetailView) {
  if (!view.configured) {
    return <Empty>No Flag Configuration here, so there are no Targeting Rules to edit.</Empty>;
  }
  return isLocked(view, "targeting") ? (
    <FlagTargetingSummary view={view} />
  ) : (
    <FlagTargetingRulesEditor editing={editing} view={view} />
  );
}

/**
 * Three outcomes, never collapsed into two: an unconfigured Environment, a
 * Configuration that has not narrowed the catalog (the whole catalog is a
 * candidate), and an explicitly narrowed set. Collapsing "not narrowed" into
 * "none available" would claim this Flag can serve nothing, which is the reverse
 * of the truth.
 */
function renderAvailability(view: FlagDetailView) {
  if (!view.configured) {
    return <Empty>No Flag Configuration here, so no Variant can be served.</Empty>;
  }
  if (!view.availabilityNarrowed) {
    return (
      <p className="text-muted-foreground text-sm leading-6" data-flag-availability="not-narrowed">
        Not narrowed in this Environment: every Variant in the catalog is a candidate.
      </p>
    );
  }
  return (
    <p className="text-foreground text-sm leading-6" data-flag-availability="narrowed">
      {view.availableVariantCount} of {view.catalog.length} catalog Variants available here.
    </p>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.14em]">
      {children}
    </p>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-sm leading-6">{children}</p>;
}
