import { Dialog } from "@splitch/ui/components/dialog";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("#lib/control-plane-organization-functions", () => ({
  createControlPanelOrganization: vi.fn(),
}));

const { CreateOrganizationForm } = await import("./create-organization-form");

function renderForm() {
  // DialogTitle/DialogFooter read the Dialog root context.
  return renderToStaticMarkup(
    <Dialog open>
      <CreateOrganizationForm onCreated={() => {}} onStaleSession={() => {}} />
    </Dialog>,
  );
}

describe("Create Organization form", () => {
  it("asks for a name and a handle, and says where the handle shows up", () => {
    const html = renderForm();

    expect(html).toContain('id="org-name"');
    expect(html).toContain('id="org-slug"');
    expect(html).toContain("Appears in every URL for this Organization");
  });

  it("teaches what an Organization is rather than assuming the user knows", () => {
    expect(renderForm()).toContain("account boundary");
  });

  it("renders no error surface until something has actually failed", () => {
    expect(renderForm()).not.toContain("create-organization-error");
  });
});
