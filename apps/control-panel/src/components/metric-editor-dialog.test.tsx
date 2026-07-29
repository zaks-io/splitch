import type { Metric } from "@splitch/contracts";
import { Dialog } from "@splitch/ui/components/dialog";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MetricForm } from "./metric-form";
import { MetricsPage, removeMetric, upsertMetric } from "./metrics-page";

vi.mock("#lib/control-plane-metric-functions", () => ({
  deleteControlPanelMetric: vi.fn(),
  saveControlPanelMetric: vi.fn(),
}));

describe("Metric editor dialog", () => {
  it("does not expose an inert Create Metric button in server-rendered HTML", () => {
    const html = renderToStaticMarkup(
      <MetricsPage appId="app_billing" environmentId="env_prod" metrics={[]} />,
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

  it("commits Worker create, update, and delete results without a route reload", () => {
    const created = metric({ id: "metric_signups", key: "signups", name: "Signups" });
    const updated = { ...created, name: "Completed signups" };

    expect(upsertMetric([], created)).toEqual([created]);
    expect(upsertMetric([created], updated)).toEqual([updated]);
    expect(removeMetric([updated], created.id)).toEqual([]);
  });
});

function metric(overrides: Partial<Metric> = {}): Metric {
  return {
    id: "metric_1",
    appId: "app_billing",
    name: "Metric",
    key: "metric",
    kind: "binomial",
    eventName: "metric_happened",
    createdAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}
