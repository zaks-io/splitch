import { AppErrorPage } from "@splitch/ui/state/app-error-page";
import { PanelSkeleton } from "@splitch/ui/state/panel-skeleton";
import { SectionErrorPage } from "@splitch/ui/state/section-error-page";
import { StaleDataToast } from "@splitch/ui/state/stale-data-toast";
import { TableSkeleton } from "@splitch/ui/state/table-skeleton";
import { WidgetErrorState } from "@splitch/ui/state/widget-error-state";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

describe("control-panel error and loading surfaces", () => {
  it("renders the app, section, widget, and stale-data surfaces", () => {
    const html = renderToStaticMarkup(
      <>
        <AppErrorPage />
        <SectionErrorPage />
        <WidgetErrorState />
        <StaleDataToast />
      </>,
    );

    expect(html).toContain("Page unavailable");
    expect(html).toContain("Section unavailable");
    expect(html).toContain("Widget unavailable");
    expect(html).toContain("Data may be out of date");
  });

  it("uses skeletons for route pending states", () => {
    const html = renderToStaticMarkup(
      <>
        <PanelSkeleton />
        <TableSkeleton />
      </>,
    );

    expect(html).toContain('data-slot="panel-skeleton"');
    expect(html).toContain('data-slot="table-skeleton"');
    expect(html).not.toContain("spinner");
  });
});
