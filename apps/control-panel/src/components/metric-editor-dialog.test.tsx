import { Dialog } from "@splitch/ui/components/dialog";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MetricForm } from "./metric-form";
import { MetricsPage } from "./metrics-page";

vi.mock("#lib/control-plane-metric-functions", () => ({
  deleteControlPanelMetric: vi.fn(),
  saveControlPanelMetric: vi.fn(),
}));

describe("Metric editor dialog", () => {
  it("does not expose an inert Create Metric button in server-rendered HTML", () => {
    const html = renderToStaticMarkup(
      <MetricsPage
        appId="app_billing"
        environmentId="env_prod"
        metrics={[]}
        readLimit={200}
        readTruncated={false}
      />,
    );
    const trigger = html.match(/<button[^>]*>Create Metric<\/button>/)?.[0];

    expect(trigger).toContain('disabled=""');
  });

  it("mounts the Metric form when the dialog opens", () => {
    const html = renderToStaticMarkup(
      <Dialog open>
        <MetricForm
          appId="app_billing"
          environmentId="env_prod"
          metrics={[]}
          onDeleted={() => {}}
          onSaved={() => {}}
        />
      </Dialog>,
    );

    expect(html).toContain('id="metric-name"');
    expect(html).toContain("Metric name");
  });
});
