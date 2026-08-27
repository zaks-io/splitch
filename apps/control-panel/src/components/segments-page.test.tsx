import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteControlPanelSegment } from "#lib/control-plane-segment-functions";
import { deleteUnparseableSegment, SegmentsPage } from "./segments-page";

vi.mock("#lib/control-plane-segment-functions", () => ({
  deleteControlPanelSegment: vi.fn(),
  saveControlPanelSegment: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: vi.fn() }),
}));

describe("SegmentsPage unparseable surface", () => {
  beforeEach(() => {
    vi.mocked(deleteControlPanelSegment).mockReset();
  });

  it("renders the banner, per-row reason, and delete path for addressable rows", async () => {
    const html = renderToStaticMarkup(
      <SegmentsPage
        appId="app_billing"
        environmentId="env_prod"
        readLimit={200}
        readTruncated={false}
        segments={[]}
        unparseable={[
          {
            id: "segment_poison",
            name: "Poison",
            reason: "conditions.0.value.0: Invalid input",
          },
          {
            reason: "Segment entry is not an object",
          },
        ]}
      />,
    );

    expect(html).toContain('data-unparseable-segments="2"');
    expect(html).toContain("2 Segments could not be rendered");
    expect(html).toContain("conditions.0.value.0: Invalid input");
    expect(html).toContain('data-unparseable-segment-id="segment_poison"');
    expect(html).toContain("Delete Segment");
    expect(html).toContain("This row has no Segment id and cannot be removed from the Panel.");

    vi.mocked(deleteControlPanelSegment).mockResolvedValue({
      ok: true,
      status: 200,
      data: { deleted: true },
    });
    const deleted = await deleteUnparseableSegment({
      appId: "app_billing",
      environmentId: "env_prod",
      segmentId: "segment_poison",
      segmentName: "Poison",
      confirm: () => true,
    });
    expect(deleted).toEqual("deleted");
    expect(deleteControlPanelSegment).toHaveBeenCalledWith({
      data: {
        appId: "app_billing",
        environmentId: "env_prod",
        segmentId: "segment_poison",
      },
    });
  });

  it("says the catalog is incomplete when the Control Plane list was truncated", () => {
    const html = renderToStaticMarkup(
      <SegmentsPage
        appId="app_billing"
        environmentId="env_prod"
        readLimit={200}
        readTruncated={true}
        segments={[]}
        unparseable={[]}
      />,
    );
    expect(html).toContain('data-testid="segments-truncated"');
    expect(html).toContain("More than 200 Segments in this App");
  });

  it("counts parsed and unparseable rows in the truncated notice", () => {
    const html = renderToStaticMarkup(
      <SegmentsPage
        appId="app_billing"
        environmentId="env_prod"
        readLimit={200}
        readTruncated={true}
        segments={[]}
        unparseable={[{ reason: "Segment entry is not an object" }]}
      />,
    );
    expect(html).toContain("The 1 below are not all of them");
  });
});
