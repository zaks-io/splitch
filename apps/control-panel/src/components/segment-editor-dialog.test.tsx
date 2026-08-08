import { Dialog } from "@splitch/ui/components/dialog";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SegmentForm } from "./segment-form";
import { SegmentsPage } from "./segments-page";

vi.mock("#lib/control-plane-segment-functions", () => ({
  deleteControlPanelSegment: vi.fn(),
  saveControlPanelSegment: vi.fn(),
}));

describe("Segment editor dialog", () => {
  it("does not expose an inert Create Segment button in server-rendered HTML", () => {
    const html = renderToStaticMarkup(
      <SegmentsPage appId="app_billing" environmentId="env_prod" segments={[]} />,
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
    expect(html).toContain("Edits apply across every Environment in this App");
  });
});
