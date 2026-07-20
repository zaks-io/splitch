import type { ReactNode } from "react";

/* Section overline: the duotone dots + cobalt mono label. One per section. */
export function SectionEyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 font-mono text-arm-control text-xs uppercase tracking-wide">
      <span aria-hidden="true" className="size-2 rounded-sm bg-arm-control" />
      <span aria-hidden="true" className="-ml-1 size-2 rounded-sm bg-arm-treatment" />
      {children}
    </p>
  );
}
