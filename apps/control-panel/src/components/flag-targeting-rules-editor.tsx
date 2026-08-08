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
import type { FlagDetailView } from "#lib/flag-detail-view";
import { addTargetingRuleIntent, removeTargetingRuleIntent } from "#lib/flag-edit-intent";
import { formatConditionSummary } from "#lib/segment-form-model";
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

  const canAdd = attribute.trim() !== "" && value.trim() !== "" && variantId !== "";

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
                  {rule.conditions.map((c) => formatConditionSummary(c)).join(" AND ")}
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
          <Input
            aria-label="targeting attribute"
            className="w-40"
            data-targeting-attribute="true"
            disabled={editing.busy}
            onChange={(event) => setAttribute(event.target.value)}
            placeholder="attribute"
            value={attribute}
          />
          <span className="font-mono text-muted-foreground text-xs">equals</span>
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
                  { attribute: attribute.trim(), value: value.trim(), variantId },
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
          A new rule serves every request that matches. Percentage rollout on a rule is not editable
          here yet.
        </p>
      </div>
    </div>
  );
}
