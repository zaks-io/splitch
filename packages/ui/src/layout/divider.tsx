import type { ComponentProps } from "react";

import { Separator } from "#components/separator";

type DividerProps = ComponentProps<typeof Separator>;

function Divider(props: DividerProps) {
  return <Separator data-slot="divider" {...props} />;
}

export { Divider };
