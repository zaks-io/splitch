import { createSplitchReact } from "@splitch/convex/react";
import { api } from "../convex/_generated/api";

const { useFlagDetails } = createSplitchReact(api.splitch.reactFlag);

export function App() {
  const details = useFlagDetails("shared-preview-smoke", false);
  if (details === undefined) return <main>Loading Flag…</main>;

  return (
    <main>
      <h1>Splitch Convex React dogfood</h1>
      <dl>
        <dt>Value</dt>
        <dd>{String(details.value)}</dd>
        <dt>Variant</dt>
        <dd>{details.variantName ?? "none"}</dd>
        <dt>Reason</dt>
        <dd>{details.reason}</dd>
      </dl>
    </main>
  );
}
