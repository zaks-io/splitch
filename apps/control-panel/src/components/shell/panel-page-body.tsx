import { cn } from "@splitch/ui/lib/utils";
import type { ReactNode } from "react";

/** The one body inset for Panel screens, paired with PanelPageHeader. */
export function PanelPageBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("px-8 py-6", className)}>{children}</div>;
}
