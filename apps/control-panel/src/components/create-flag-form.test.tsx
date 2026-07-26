import { Dialog } from "@splitch/ui/components/dialog";
import type { ComponentProps } from "react";
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

function renderRow(overrides: Partial<ComponentProps<typeof VariantRowEditor>> = {}) {
  return renderToStaticMarkup(
    <VariantRowEditor
      canRemove
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
      {...overrides}
    />,
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
    // Up/Down are disabled here anyway, so the assertion must be scoped to the
    // Remove button. Match the `disabled` attribute, not the substring: the
    // Tailwind class list carries `disabled:pointer-events-none` either way.
    const removeButton = /<button[^>]*aria-label="Remove control"[^>]*>/;
    const isDisabled = (html: string) => / disabled=""/.test(html.match(removeButton)?.[0] ?? "");

    expect(isDisabled(renderRow({ canRemove: false }))).toBe(true);
    expect(isDisabled(renderRow({ canRemove: true }))).toBe(false);
  });

  it("renders a row's inline validation message next to the row", () => {
    const html = renderRow({
      index: 1,
      issues: [{ path: "variants.1.value", message: "Enter a JSON object." }],
      valueType: "object",
      variant: { name: "treatment", value: "{ not json", description: "" },
    });

    expect(html).toContain("Enter a JSON object.");
    expect(html).toContain('aria-invalid="true"');
    // The message is announced, not just coloured.
    expect(html).toContain('aria-describedby="variant-value-error-1"');
    expect(html).toContain('id="variant-value-error-1"');
  });

  it("shows both a name and a value error on the same row", () => {
    const html = renderRow({
      issues: [
        { path: "variants.0.name", message: "Enter a Variant name." },
        { path: "variants.0.value", message: "Enter a value." },
      ],
      variant: { name: "", value: "", description: "" },
    });

    expect(html).toContain("Enter a Variant name.");
    expect(html).toContain("Enter a value.");
  });
});
