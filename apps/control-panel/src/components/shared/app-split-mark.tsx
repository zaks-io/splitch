import { cn } from "@splitch/ui/lib/utils";

/**
 * The split identity mark: control cobalt beside treatment chartreuse.
 * Marks an App wherever one is named, so the pair reads as "an App" at a glance.
 */
export function AppSplitMark({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("flex shrink-0", className)}>
      <span className="h-3.5 w-2 rounded-l bg-arm-control" />
      <span className="h-3.5 w-2 rounded-r bg-arm-treatment" />
    </span>
  );
}
