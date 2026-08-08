import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@splitch/ui/components/table";
import type { FlagDetailView } from "#lib/flag-detail-view";
import { formatConditionSummary } from "#lib/segment-form-model";

/**
 * Targeting Rules as read-only truth, for the case where a running Experiment
 * owns them.
 *
 * This is what the screen renders INSTEAD of the editor, not alongside it: there
 * is no edit control in this tree at all, so there is nothing to disable and
 * nothing that can misfire.
 */
export function FlagTargetingSummary({ view }: { view: FlagDetailView }) {
  if (view.targetingRules.length === 0) {
    return (
      <p className="text-muted-foreground text-sm leading-6">
        No Targeting Rules in this Environment.
      </p>
    );
  }

  return (
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
              {rule.conditions.map((c) => formatConditionSummary(c)).join(" AND ")}
            </TableCell>
            <TableCell className="font-mono">{rule.variantName}</TableCell>
            <TableCell className="text-right text-muted-foreground">
              {rule.rolloutPercentage === null ? "All matches" : `${rule.rolloutPercentage}%`}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
