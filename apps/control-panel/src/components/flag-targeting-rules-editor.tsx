import { Button } from "@splitch/ui/components/button";
import { Input } from "@splitch/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@splitch/ui/components/table";
import { useState } from "react";
import { type FlagDetailView, targetingRuleConditionsText } from "#lib/flag-detail-view";
import { addTargetingRuleIntent, removeTargetingRuleIntent } from "#lib/flag-edit-intent";
import type { FlagEditing } from "#lib/use-flag-editing";

/**
 * The Targeting Rules of ONE Environment, editable as a whole list.
 *
 * A new rule serves all matches and carries no percentage: a rule-level rollout
 * needs a bucketing salt, the salt is server-minted and has no minting path on
 * this route yet, and inventing one here would silently decide who gets bucketed
 * (SPL-245). Existing rules go back verbatim, salt included.
 *
 * This component is rendered only when the field group is unlocked. An Experiment
 * that owns targeting makes it structurally absent, not disabled — a frozen
 * control that can still fire is a control that will fire.
 */
export function FlagTargetingRulesEditor({
  editing,
  view,
}: {
  editing: FlagEditing;
  view: FlagDetailView;
}) {
  const [attribute, setAttribute] = useState("");
  const [value, setValue] = useState("");
  const [variantId, setVariantId] = useState(view.catalog[0]?.id ?? "");
  const [segmentId, setSegmentId] = useState("");

  const hasCondition = attribute.trim() !== "" && value.trim() !== "";
  const hasPartialCondition = (attribute.trim() === "") !== (value.trim() === "");
  const canAdd = !hasPartialCondition && (hasCondition || segmentId !== "") && variantId !== "";

  return (
    <div className="grid gap-4" data-flag-targeting-editor="true">
      {view.targetingRules.length === 0 ? (
        <p className="text-muted-foreground text-sm leading-6">
          No Targeting Rules in this Environment.
        </p>
      ) : (
        <Table data-flag-targeting-rules={view.targetingRules.length}>
          <TableHeader>
            <TableRow>
              <TableHead>Priority</TableHead>
              <TableHead>Conditions</TableHead>
              <TableHead>Serves</TableHead>
              <TableHead className="text-right">Rollout</TableHead>
              <TableHead className="text-right">Remove</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.targetingRules.map((rule) => (
              <TableRow data-targeting-rule={rule.id} key={rule.id}>
                <TableCell className="font-mono">{rule.priority}</TableCell>
                <TableCell className="text-muted-foreground text-xs leading-5">
                  {targetingRuleConditionsText(rule)}
                </TableCell>
                <TableCell className="font-mono">{rule.variantName}</TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {rule.rolloutPercentage === null ? "All matches" : `${rule.rolloutPercentage}%`}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    aria-label={`remove Targeting Rule ${rule.priority}`}
                    data-targeting-remove={rule.id}
                    disabled={editing.busy}
                    onClick={() => void editing.submit(removeTargetingRuleIntent(rule.id))}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Remove
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <div className="grid gap-2 rounded-md border border-border p-3">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.14em]">
          Add a rule
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Segment"
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
            data-targeting-segment="true"
            disabled={editing.busy}
            onChange={(event) => setSegmentId(event.target.value)}
            value={segmentId}
          >
            <option value="">No Segment</option>
            {view.segments.map((segment) => (
              <option key={segment.id} value={segment.id}>
                {segment.name}
              </option>
            ))}
          </select>
          {segmentId === "" ? null : (
            <span className="font-mono text-muted-foreground text-xs">AND</span>
          )}
          <Input
            aria-label="targeting attribute"
            className="w-40"
            data-targeting-attribute="true"
            disabled={editing.busy}
            onChange={(event) => setAttribute(event.target.value)}
            placeholder="attribute"
            value={attribute}
          />
          <span className="font-mono text-muted-foreground text-xs">eq</span>
          <Input
            aria-label="targeting value"
            className="w-40"
            data-targeting-value="true"
            disabled={editing.busy}
            onChange={(event) => setValue(event.target.value)}
            placeholder="value"
            value={value}
          />
          <span className="font-mono text-muted-foreground text-xs">serves</span>
          <select
            aria-label="served Variant"
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
            data-targeting-variant="true"
            disabled={editing.busy}
            onChange={(event) => setVariantId(event.target.value)}
            value={variantId}
          >
            {view.catalog.map((variant) => (
              <option key={variant.id} value={variant.id}>
                {variant.name}
              </option>
            ))}
          </select>
          <Button
            data-targeting-add="true"
            disabled={editing.busy || !canAdd}
            onClick={() =>
              void editing.submit(
                addTargetingRuleIntent(
                  {
                    ...(hasCondition ? { attribute: attribute.trim(), value: value.trim() } : {}),
                    ...(segmentId ? { segmentId } : {}),
                    variantId,
                  },
                  crypto.randomUUID(),
                ),
              )
            }
            type="button"
          >
            Add rule
          </Button>
        </div>
        <p className="text-muted-foreground text-xs leading-5">
          Choose a Segment, a direct Condition, or both; a rule with both serves only traffic that
          matches the Segment and the Condition. Percentage rollout on a rule is not editable here
          yet.
        </p>
      </div>
    </div>
  );
}
