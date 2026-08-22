import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { PanelPageBody } from "./panel-page-body";

export function SectionUnavailable({ title }: { title: string }) {
  return (
    <PanelPageBody>
      <SectionErrorPage title={title} />
    </PanelPageBody>
  );
}
