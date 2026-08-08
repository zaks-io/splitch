import type { PanelSegment } from "@splitch/control-plane-sdk/panel-segments";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@splitch/ui/components/table";
import { formatConditionSummary } from "#lib/segment-form-model";
import { SegmentEditorDialog } from "./segment-editor-dialog";

export function SegmentsTable({
  appId,
  environmentId,
  onDeleted,
  onSaved,
  segments,
}: {
  appId: string;
  environmentId: string;
  onDeleted: (segmentId: string) => void | Promise<void>;
  onSaved: (segment: PanelSegment) => void | Promise<void>;
  segments: PanelSegment[];
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Segment</TableHead>
            <TableHead>Conditions</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {segments.map((segment) => (
            <TableRow
              data-segment-id={segment.id}
              data-segment-name={segment.name}
              key={segment.id}
            >
              <TableCell>
                <div className="flex flex-col gap-1">
                  <span className="font-medium">{segment.name}</span>
                  {segment.description ? (
                    <span className="text-muted-foreground text-sm">{segment.description}</span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell>
                {segment.conditions.length === 0 ? (
                  <span className="text-muted-foreground text-sm">No Conditions</span>
                ) : (
                  <ul className="grid gap-1">
                    {segment.conditions.map((condition) => (
                      <li
                        className="font-mono text-sm"
                        key={`${segment.id}:${condition.attribute}:${condition.operator}:${String(condition.value)}`}
                      >
                        {formatConditionSummary(condition)}
                      </li>
                    ))}
                  </ul>
                )}
              </TableCell>
              <TableCell className="text-right">
                <SegmentEditorDialog
                  appId={appId}
                  environmentId={environmentId}
                  onDeleted={onDeleted}
                  onSaved={onSaved}
                  segment={segment}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
