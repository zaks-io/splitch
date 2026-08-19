import type { PanelAppCatalogFlag } from "@splitch/control-plane-sdk/panel-app-settings";
import type { Repository } from "@splitch/db";

type FlagRow = Awaited<ReturnType<Repository["flags"]["listFlagPage"]>>[number];
type VariantRow = Awaited<ReturnType<Repository["flags"]["listVariants"]>>[number];

/**
 * The App-level Flag catalog as the Settings screen shows it.
 *
 * Variant values are rendered to text here rather than in the browser: they are
 * arbitrary JSON, the Panel's server-function boundary carries primitives only,
 * and one rendering used everywhere beats two that can disagree.
 */
export function catalogFlag(row: FlagRow, variants: readonly VariantRow[]): PanelAppCatalogFlag {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    variants: variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      value: renderVariantValue(variant.value),
    })),
    // Null, never the first Variant: a `defaultVariantId` that names nothing in
    // the catalog is corrupt data, and silently standing in for it would hide
    // exactly the row an operator opened this screen to find (ADR-0036).
    defaultVariantName:
      variants.find((variant) => variant.id === row.defaultVariantId)?.name ?? null,
  };
}

/** `variants.value` is stored JSON, so a string Variant reads back quoted. */
function renderVariantValue(stored: string): string {
  const parsed: unknown = JSON.parse(stored);
  return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
}
