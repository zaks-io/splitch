import type { ComponentProps } from "react";

import { cn } from "#lib/utils";

const gapClasses = {
  "1": "gap-1",
  "2": "gap-2",
  "3": "gap-3",
  "4": "gap-4",
  "6": "gap-6",
  "8": "gap-8",
} as const;

const alignClasses = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
} as const;

type StackProps = ComponentProps<"div"> & {
  align?: keyof typeof alignClasses;
  gap?: keyof typeof gapClasses;
};

function Stack({ align = "stretch", className, gap = "4", ...props }: StackProps) {
  return (
    <div
      data-slot="stack"
      className={cn("flex flex-col", gapClasses[gap], alignClasses[align], className)}
      {...props}
    />
  );
}

export { Stack };
