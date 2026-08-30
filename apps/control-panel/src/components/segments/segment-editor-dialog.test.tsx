import { Dialog } from "@splitch/ui/components/dialog";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SegmentForm } from "#components/segments/segment-form";
import { SegmentsPage } from "#components/segments/segments-page";

vi.mock("#lib/segments/control-plane-segment-functions", () => ({
  deleteControlPanelSegment: vi.fn(),
  saveControlPanelSegment: vi.fn(),
}));

describe("Segment editor dialog", () => {
  it("does not expose an inert Create Segment button in server-rendered HTML", () => {
    const html = renderToStaticMarkup(
      <SegmentsPage
        appId="app_billing"
        environmentId="env_prod"
        readLimit={200}
        readTruncated={false}
        segments={[]}
        unparseable={[]}
      />,
    );
    const trigger = html.match(/<button[^>]*>Create Segment<\/button>/)?.[0];

    expect(trigger).toContain('disabled=""');
  });

  it("mounts the Segment form when the dialog opens", () => {
    const html = renderToStaticMarkup(
      <Dialog open>
        <SegmentForm
          appId="app_billing"
          environmentId="env_prod"
          onDeleted={() => {}}
          onSaved={() => {}}
        />
      </Dialog>,
    );

    expect(html).toContain('id="segment-name"');
    expect(html).toContain("Segment name");
    expect(html).toContain("Defined once for this App");
    expect(html).toContain("Available in every Environment.");
    expect(html).not.toContain("—");
  });
});
