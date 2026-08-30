import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@splitch/ui/components/table";
import { type ApprovalDiffRow, approvalDiffGroups } from "#lib/approval/approval-diff-rows";

/**
 * The Worker's proposal, as before/after rows grouped by field group.
 *
 * Reusable by construction: it takes diff rows and nothing Flag-shaped. Promotion
 * between Environments proposes through the same contract, projects into the same
 * rows, and renders here unchanged.
 */
export function ApprovalDiffTable({ rows }: { rows: readonly ApprovalDiffRow[] }) {
  return (
    <div className="grid gap-5" data-approval-diff="true">
      {approvalDiffGroups(rows).map((group) => (
        <section className="grid gap-2" key={group} aria-label={group}>
          <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.14em]">
            {group}
          </p>
          <Table data-approval-diff-group={group}>
            <TableHeader>
              <TableRow>
                <TableHead className="w-1/3">Field</TableHead>
                <TableHead>Now</TableHead>
                <TableHead>After this change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows
                .filter((row) => row.group === group)
                .map((row) => (
                  <DiffRow key={row.path} row={row} />
                ))}
            </TableBody>
          </Table>
        </section>
      ))}
    </div>
  );
}

function DiffRow({ row }: { row: ApprovalDiffRow }) {
  return (
    <TableRow data-approval-diff-path={row.path}>
      <TableCell className="align-top font-medium text-foreground">{row.field}</TableCell>
      <TableCell className="align-top text-muted-foreground text-sm">
        <ValueLines has={row.hasBefore} lines={row.before} />
      </TableCell>
      <TableCell className="align-top text-foreground text-sm" data-approval-diff-after="true">
        <ValueLines has={row.hasAfter} lines={row.after} />
      </TableCell>
    </TableRow>
  );
}

/**
 * "Not set" and an empty value are different facts, so absence is stated rather
 * than rendered as a blank cell the reader has to interpret.
 */
function ValueLines({ has, lines }: { has: boolean; lines: readonly string[] }) {
  if (!has) return <span className="italic">Not set</span>;
  if (lines.length === 0) return <span className="italic">Empty</span>;
  return (
    <ul className="grid gap-1">
      {lines.map((line) => (
        <li className="break-words leading-5" key={line}>
          {line}
        </li>
      ))}
    </ul>
  );
}
