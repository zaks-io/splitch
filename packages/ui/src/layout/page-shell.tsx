import type { ComponentProps } from "react";

import { cn } from "#lib/utils";

const sizeClasses = {
  sm: "max-w-3xl",
  md: "max-w-5xl",
  lg: "max-w-7xl",
  full: "max-w-none",
} as const;

type PageShellProps = ComponentProps<"main"> & {
  size?: keyof typeof sizeClasses;
};

function PageShell({ className, size = "lg", ...props }: PageShellProps) {
  return (
    <main
      data-slot="page-shell"
      className={cn("mx-auto grid w-full gap-8 px-4 py-8 sm:px-6", sizeClasses[size], className)}
      {...props}
    />
  );
}

export { PageShell };
