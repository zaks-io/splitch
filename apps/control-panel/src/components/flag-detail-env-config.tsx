import { Badge } from "@splitch/ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@splitch/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@splitch/ui/components/table";
import { type FlagDetailView, isLocked } from "#lib/flag-detail-view";
import { FlagDetailLock } from "./flag-detail-lock";

/**
 * The PRIMARY content of the Flag detail screen: what this one Environment serves.
 *
 * It leads because the URL grain is an Environment and that is where flag work
 * happens (screen-inventory.md). Every value shown is this Environment's, so an
 * unconfigured Flag says so outright rather than borrowing another Environment's
 * numbers.
 */
export function FlagDetailEnvConfig({ view }: { view: FlagDetailView }) {
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
          <div className="flex flex-wrap items-center gap-3" data-flag-kill-switch="true">
            <Badge variant={view.enabled ? "default" : "secondary"}>
              {view.enabled ? "Enabled" : "Disabled"}
            </Badge>
            <span className="text-muted-foreground text-xs leading-5">
              {view.configured
                ? "Never locked, so this Flag can always be turned off."
                : "No Flag Configuration in this Environment yet, so nothing is served here."}
            </span>
          </div>
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
          {view.targetingRules.length === 0 ? (
            <Empty>No Targeting Rules in this Environment.</Empty>
          ) : (
            <Table data-flag-targeting-rules={view.targetingRules.length}>
              <TableHeader>
                <TableRow>
                  <TableHead>Priority</TableHead>
                  <TableHead>Conditions</TableHead>
                  <TableHead>Serves</TableHead>
                  <TableHead className="text-right">Rollout</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.targetingRules.map((rule) => (
                  <TableRow data-targeting-rule={rule.id} key={rule.id}>
                    <TableCell className="font-mono">{rule.priority}</TableCell>
                    <TableCell className="text-muted-foreground text-xs leading-5">
                      {rule.conditions
                        .map(
                          (condition) =>
                            `${condition.attribute} ${condition.operator} ${condition.value}`,
                        )
                        .join(" AND ")}
                    </TableCell>
                    <TableCell className="font-mono">{rule.variantName}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {rule.rolloutPercentage === null
                        ? "All matches"
                        : `${rule.rolloutPercentage}%`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>

        <section className="grid gap-2" aria-label="Baseline rollout">
          <FieldLabel>Baseline rollout</FieldLabel>
          <p className="text-foreground text-sm leading-6" data-flag-baseline-rollout="true">
            {view.baselineRolloutPercentage === null
              ? "No baseline percentage rollout."
              : `${view.baselineRolloutPercentage}% of traffic`}
          </p>
        </section>
      </CardContent>
    </Card>
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
