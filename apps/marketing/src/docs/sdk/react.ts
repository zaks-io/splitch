import type { SdkTopic } from "./types";

export const reactTopic: SdkTopic = {
  slug: "react",
  title: "React bindings",
  summary: "Provide one initialized browser client and subscribe each hook to one Flag.",
  section: "integration",
  blocks: [
    {
      kind: "prose",
      text: "`@splitch/sdk/react` borrows an initialized browser client. Each hook subscribes to one Flag, so a changed Flag re-renders only its own subscribers. The first committed read redeems its Exposure Ticket.",
    },
    {
      kind: "code",
      lang: "tsx",
      code: `import { createRoot } from "react-dom/client";
import { createSplitchBrowserClient } from "@splitch/sdk/browser";
import { SplitchProvider, useFlag, useFlagDetails } from "@splitch/sdk/react";

const splitch = createSplitchBrowserClient({
  clientKey: "pk_...",
  context: { targetingKey: "user-123" },
});
await splitch.init();

function Checkout() {
  const enabled = useFlag("new-checkout", false);
  const details = useFlagDetails("new-checkout", false);
  return <p>{enabled ? details.variantName : "control"}</p>;
}

createRoot(document.getElementById("root")!).render(
  <SplitchProvider client={splitch}>
    <Checkout />
  </SplitchProvider>,
);`,
    },
    {
      kind: "prose",
      text: "`useSplitchClient()` returns the borrowed client for `flush()`, `close()`, and imperative reads. Hooks outside `SplitchProvider` throw `SDK_REACT_PROVIDER_MISSING`.",
    },
    {
      kind: "prose",
      text: "An unknown Flag preserves the browser client's loud `FLAG_NOT_FOUND` details and returns the caller's Default Variant.",
    },
  ],
};
