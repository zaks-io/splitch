const TREATMENT_COLORS = [
  "var(--arm-treatment)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

export function armColor({
  baseline,
  variant,
  variantOrder,
}: {
  baseline: string;
  variant: string;
  variantOrder: readonly string[];
}): string {
  if (variant === baseline) return "var(--arm-control)";
  const treatmentIndex = variantOrder.filter((name) => name !== baseline).indexOf(variant);
  if (treatmentIndex < 0) return "var(--muted-foreground)";
  return TREATMENT_COLORS[treatmentIndex] ?? "var(--muted-foreground)";
}
