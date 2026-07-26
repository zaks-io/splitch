import { Dialog } from "@splitch/ui/components/dialog";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { VariantRowEditor } from "./variant-row-editor";

vi.mock("#lib/control-plane-flag-functions", () => ({
  createControlPanelFlag: vi.fn(),
}));

const { CreateFlagForm } = await import("./create-flag-form");

function renderForm() {
  // DialogTitle/DialogFooter read the Dialog root context.
  return renderToStaticMarkup(
    <Dialog open>
      <CreateFlagForm appId="app_checkout" environmentId="env_dev" onCreated={() => {}} />
    </Dialog>,
  );
}

describe("Create Flag form", () => {
  it("opens on the boolean preset so the common case stays zero-configuration", () => {
    const html = renderForm();

    expect(html).toContain('value="disabled"');
    expect(html).toContain('value="enabled"');
    expect(html).toContain('id="variant-value-0"');
    expect(html).toContain('id="variant-value-1"');
    expect(html).not.toContain('id="variant-value-2"');
  });

  it("offers every contract-supported value type", () => {
    const html = renderForm();

    for (const valueType of ["boolean", "string", "number", "object"]) {
      expect(html).toContain(`<option value="${valueType}"`);
    }
  });

  it("exposes add, reorder, remove and Default controls per Variant", () => {
    const html = renderForm();

    expect(html).toContain("Add Variant");
    expect(html).toContain('name="default-variant"');
    expect(html).toContain("Move disabled up");
    expect(html).toContain("Move enabled down");
    expect(html).toContain("Remove enabled");
  });

  it("keeps the sole Variant's Remove control disabled, since a Flag needs one", () => {
    const html = renderToStaticMarkup(
      <VariantRowEditor
        canRemove={false}
        index={0}
        isDefault
        isFirst
        isLast
        issues={[]}
        onChange={() => {}}
        onMakeDefault={() => {}}
        onMove={() => {}}
        onRemove={() => {}}
        valueType="string"
        variant={{ name: "control", value: "control", description: "" }}
      />,
    );

    expect(html).toContain('aria-label="Remove control"');
    expect(html).toContain("disabled");
  });

  it("renders a row's inline validation message next to the row", () => {
    const html = renderToStaticMarkup(
      <VariantRowEditor
        canRemove
        index={1}
        isDefault={false}
        isFirst={false}
        isLast
        issues={[{ path: "variants.1.value", message: "Enter a JSON object." }]}
        onChange={() => {}}
        onMakeDefault={() => {}}
        onMove={() => {}}
        onRemove={() => {}}
        valueType="object"
        variant={{ name: "treatment", value: "{ not json", description: "" }}
      />,
    );

    expect(html).toContain("Enter a JSON object.");
    expect(html).toContain('aria-invalid="true"');
  });
});
