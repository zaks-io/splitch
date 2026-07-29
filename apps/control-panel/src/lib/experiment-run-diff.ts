import type { PanelExperimentRun } from "@splitch/control-plane-sdk/panel-experiments";

type RunVariant = { id: string; name: string; value: unknown };

export function describeRunChange(
  run: PanelExperimentRun,
  previous: PanelExperimentRun | undefined,
): string {
  if (!previous) return "Experiment started";

  const changes = [
    allocationChange(previous, run),
    variantSetChange(previous, run),
    previous.targetingKey === run.targetingKey
      ? null
      : `Targeting Key ${previous.targetingKey} → ${run.targetingKey}`,
    stableJson(JSON.parse(previous.targetingRulesJson)) ===
    stableJson(JSON.parse(run.targetingRulesJson))
      ? null
      : "Targeting changed",
    previous.salt === run.salt ? null : "Assignment salt changed",
  ].filter((change): change is string => Boolean(change));

  return changes.length > 0 ? changes.join(" · ") : "Assignment configuration unchanged";
}

function allocationChange(previous: PanelExperimentRun, run: PanelExperimentRun): string | null {
  if (stableJson(previous.allocation) === stableJson(run.allocation)) return null;
  const previousNames = Object.keys(previous.allocation).sort();
  const currentNames = Object.keys(run.allocation).sort();
  const sameVariants =
    previousNames.length === currentNames.length &&
    previousNames.every((name, index) => name === currentNames[index]);
  const format = sameVariants ? allocationShares : allocationLabeledShares;
  return `Allocation ${format(previous.allocation)} → ${format(run.allocation)}`;
}

function variantSetChange(previous: PanelExperimentRun, run: PanelExperimentRun): string | null {
  const previousVariants = variantSnapshot(previous);
  const currentVariants = variantSnapshot(run);
  const previousByName = new Map(previousVariants.map((variant) => [variant.name, variant]));
  const currentByName = new Map(currentVariants.map((variant) => [variant.name, variant]));
  const added = currentVariants.filter((variant) => !previousByName.has(variant.name));
  const removed = previousVariants.filter((variant) => !currentByName.has(variant.name));
  const changed = currentVariants.filter((variant) => {
    const prior = previousByName.get(variant.name);
    return (
      prior !== undefined &&
      stableJson({ id: prior.id, value: prior.value }) !==
        stableJson({ id: variant.id, value: variant.value })
    );
  });
  const byName = (left: { name: string }, right: { name: string }) =>
    left.name.localeCompare(right.name);
  const changes = [
    ...added.sort(byName).map((variant) => `Added Variant \`${variant.name}\``),
    ...removed.sort(byName).map((variant) => `Removed Variant \`${variant.name}\``),
    ...changed.sort(byName).map((variant) => `Changed Variant \`${variant.name}\``),
  ];
  return changes.length > 0 ? changes.join(", ") : null;
}

function variantSnapshot(run: PanelExperimentRun): RunVariant[] {
  return JSON.parse(run.variantsJson) as RunVariant[];
}

function allocationShares(allocation: Record<string, number>): string {
  return Object.keys(allocation)
    .sort()
    .map((name) => formatPercent(allocation[name] ?? 0))
    .join("/");
}

function allocationLabeledShares(allocation: Record<string, number>): string {
  return Object.keys(allocation)
    .sort()
    .map((name) => `${name} ${formatPercent(allocation[name] ?? 0)}`)
    .join(", ");
}

function formatPercent(value: number): string {
  return `${Number(value.toFixed(2))}%`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
