import { TableSkeleton } from "@splitch/ui/state/table-skeleton";
import { PanelPageBody } from "./panel-page-body";

export function SectionPending() {
  return (
    <PanelPageBody>
      <TableSkeleton />
    </PanelPageBody>
  );
}
