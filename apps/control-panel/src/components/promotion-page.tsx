import { Button } from "@splitch/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@splitch/ui/components/card";
import type { FlagDetailView } from "#lib/flag-detail-view";
import { type PromotionRow, promotionDiff } from "#lib/promotion-diff";
import {
  availabilityOnlySelection,
  variantSelection,
  wholeConfigSelection,
} from "#lib/promotion-selection";
import { type FlagPromotionScope, useFlagPromotion } from "#lib/use-flag-promotion";
import { GatedWriteOutcome } from "./gated-write-outcome";
import { PromotionDependencyNudge } from "./promotion-dependency-nudge";
import { PromotionDiffTable } from "./promotion-diff-table";
import { PromotionSourcePicker } from "./promotion-source-picker";

/**
 * "Promote from {source}" — the Promotion screen, which IS the diff.
 *
 * Framed as a PULL into the target: the operator stands in the Environment about
 * to change, sees exactly what changes, and is governed by that Environment's
 * Policy (screen-inventory.md). Nothing here predicts whether the write will be
 * gated; the Worker decides, and the outcome region reports what it decided.
 */
export function PromotionPage({
  appId,
  scopeHref,
  source,
  target,
  sourceEnvironmentId,
  targetEnvironmentId,
  sourceOptions,
}: {
  appId: string;
  scopeHref: string;
  source: FlagDetailView;
  target: FlagDetailView;
  sourceEnvironmentId: string;
  targetEnvironmentId: string;
  sourceOptions: readonly { env: string; environmentId: string }[];
}) {
  const diff = promotionDiff(source, target);
  const scope: FlagPromotionScope = {
    appId,
    targetEnvironmentId,
    targetEnv: target.env,
    fromEnvironmentId: sourceEnvironmentId,
    sourceEnv: source.env,
    flagId: target.flagId,
    variantLabels: Object.fromEntries(target.catalog.map((variant) => [variant.id, variant.name])),
  };
  const promotion = useFlagPromotion({ scope, rows: diff.rows, source, target });

  return (
    <section
      aria-labelledby="promotion-title"
      className="grid gap-6"
      data-promotion-source={source.env}
      data-promotion-target={target.env}
    >
      <header className="grid gap-2">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.16em]">
          <a
            className="underline underline-offset-4 hover:no-underline"
            href={`${scopeHref}/flags/${encodeURIComponent(target.key)}`}
          >
            {target.name}
          </a>{" "}
          / {target.env} Environment
        </p>
        <h1 className="font-semibold text-3xl text-foreground tracking-tight" id="promotion-title">
          Promote from <span className="font-mono text-[0.8em]">{source.env}</span>
        </h1>
        <p className="max-w-2xl text-muted-foreground text-sm leading-6">
          You are standing in <span className="font-mono text-foreground">{target.env}</span>, the
          Environment about to change. Tick the field groups to pull in;{" "}
          <span className="font-mono text-foreground">{target.env}</span>&rsquo;s own Policy decides
          whether the change applies immediately or becomes an Approval Request.
        </p>
        <PromotionSourcePicker
          currentEnv={source.env}
          flagKey={target.key}
          options={sourceOptions}
          scopeHref={scopeHref}
        />
      </header>

      <GatedWriteOutcome
        ungatedCopy={`Promoted into ${target.env}. This Environment's Policy does not gate these field groups, so no Approval Request was needed.`}
        write={promotion}
      />

      <Card>
        <CardHeader className="border-border border-b py-4">
          <CardTitle className="text-base">Flag Configuration diff</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6 pt-6">
          {diff.rows.length === 0 ? (
            <p className="text-muted-foreground text-sm leading-6" data-promotion-empty="true">
              <span className="font-mono text-foreground">{source.env}</span> and{" "}
              <span className="font-mono text-foreground">{target.env}</span> already match. There
              is nothing to promote.
            </p>
          ) : (
            <>
              <Presets
                disabled={promotion.busy}
                onSelect={promotion.replaceSelection}
                rows={diff.rows}
              />
              {diff.sourceAvailabilityNotNarrowed ? (
                <p
                  className="text-muted-foreground text-xs leading-5"
                  data-promotion-source-not-narrowed="true"
                >
                  <span className="font-mono">{source.env}</span> has never narrowed its Variant
                  availability, so its available list is empty. Promoting an availability row
                  therefore REMOVES that Variant from {target.env}.
                </p>
              ) : null}
              <PromotionDiffTable
                disabled={promotion.busy}
                onPromoteVariant={(variantName) =>
                  promotion.replaceSelection(variantSelection(diff.rows, variantName))
                }
                onToggle={promotion.toggle}
                rows={diff.rows}
                selected={promotion.selected}
                sourceEnv={source.env}
                targetEnv={target.env}
              />
              <PromotionDependencyNudge
                dependencies={promotion.dependencies}
                disabled={promotion.busy}
                onApply={promotion.toggle}
              />
              <IdenticalNote groups={diff.identical} />
              <SubmitBar promotion={promotion} targetEnv={target.env} />
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/**
 * Presets are pre-tick conveniences over the ONE mechanism, never a second path
 * to the Worker: each replaces the selection with rows that already exist in the
 * diff, so anything a preset can send is something the operator can see ticked
 * and untick (screen-inventory.md).
 */
function Presets({
  rows,
  disabled,
  onSelect,
}: {
  rows: readonly PromotionRow[];
  disabled: boolean;
  onSelect: (ids: ReadonlySet<string>) => void;
}) {
  const hasAvailability = rows.some((row) => row.kind === "availability");
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        data-promotion-preset="whole"
        disabled={disabled}
        onClick={() => onSelect(wholeConfigSelection(rows))}
        size="sm"
        type="button"
        variant="outline"
      >
        Promote whole config
      </Button>
      {hasAvailability ? (
        <Button
          data-promotion-preset="availability"
          disabled={disabled}
          onClick={() => onSelect(availabilityOnlySelection(rows))}
          size="sm"
          type="button"
          variant="outline"
        >
          Availability only
        </Button>
      ) : null}
      <Button
        data-promotion-preset="none"
        disabled={disabled}
        onClick={() => onSelect(new Set())}
        size="sm"
        type="button"
        variant="ghost"
      >
        Clear
      </Button>
    </div>
  );
}

function IdenticalNote({ groups }: { groups: readonly PromotionRow["kind"][] }) {
  if (groups.length === 0) return null;
  return (
    <p className="text-muted-foreground text-xs leading-5" data-promotion-identical="true">
      Already identical, so not listed: {groups.map(groupLabel).join(", ")}.
    </p>
  );
}

function groupLabel(kind: PromotionRow["kind"]): string {
  if (kind === "availability") return "Variant availability";
  if (kind === "targeting") return "Targeting Rules";
  if (kind === "rollout") return "baseline rollout";
  return "serving state";
}

/**
 * The payload is rendered, not just sent. `data-promotion-payload` is the exact
 * `select` this screen will submit, so "the diff shown is the diff submitted" is
 * observable from the page rather than asserted about it.
 */
function SubmitBar({
  promotion,
  targetEnv,
}: {
  promotion: ReturnType<typeof useFlagPromotion>;
  targetEnv: string;
}) {
  const count = promotion.preview.length;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-border border-t pt-5"
      data-promotion-payload={JSON.stringify(promotion.request.select)}
    >
      <p className="text-muted-foreground text-sm">
        {count === 0
          ? "Nothing ticked yet."
          : `${count} field ${count === 1 ? "group" : "groups"} ticked.`}
      </p>
      <Button
        data-promotion-submit="true"
        disabled={count === 0 || promotion.busy}
        onClick={() => void promotion.submit()}
        type="button"
      >
        {promotion.busy ? "Submitting…" : `Promote into ${targetEnv}`}
      </Button>
    </div>
  );
}
