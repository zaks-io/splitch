import { Button } from "@splitch/ui/components/button";
import type { ComponentProps } from "react";

type CtaLinkProps = ComponentProps<"a"> & {
  buttonClassName?: string;
  variant?: ComponentProps<typeof Button>["variant"];
};

export function CtaLink({ buttonClassName, children, href, variant, ...props }: CtaLinkProps) {
  return (
    <Button className={buttonClassName} render={<a href={href} {...props} />} variant={variant}>
      {children}
    </Button>
  );
}
