import type { ComponentProps } from "react";

import { cn } from "#lib/utils";

const columnClasses = {
  "1": "grid-cols-1",
  "2": "grid-cols-1 md:grid-cols-2",
  "3": "grid-cols-1 md:grid-cols-2 xl:grid-cols-3",
  "4": "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4",
  auto: "grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))]",
} as const;

const gapClasses = {
  "2": "gap-2",
  "3": "gap-3",
  "4": "gap-4",
  "6": "gap-6",
  "8": "gap-8",
} as const;

type GridProps = ComponentProps<"div"> & {
  columns?: keyof typeof columnClasses;
  gap?: keyof typeof gapClasses;
};

function Grid({ className, columns = "auto", gap = "4", ...props }: GridProps) {
  return (
    <div
      data-slot="grid"
      className={cn("grid", columnClasses[columns], gapClasses[gap], className)}
      {...props}
    />
  );
}

export { Grid };
