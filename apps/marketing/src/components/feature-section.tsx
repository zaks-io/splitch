import { CodeSnippet } from "./code-snippet";
import { SplitVisual } from "./split-visual";

const evaluateCall = `const d = await splitch.evaluateDetails("new-model", {
  targetingKey: userId,
});
if (d.reason === "ERROR") renderFallback(d.errorCode);
else respondWith(d.value);`;

export function FeatureSection() {
  return (
    <section
      className="border-border border-t bg-background px-4 py-16 sm:px-6 sm:py-24"
      id="product"
    >
      <div className="mx-auto grid w-full max-w-6xl gap-12">
        <div className="grid max-w-[65ch] gap-4">
          <h2 className="text-balance font-bold font-display text-3xl text-foreground tracking-tight sm:text-4xl">
            Start with a switch. Ask a question later.
          </h2>
          <p className="text-muted-foreground text-lg leading-relaxed">
            A Flag turns a feature on per Environment. To learn whether it helped, start an
            Experiment on the same Flag. The evaluate call you already ship records the Exposures it
            counts.
          </p>
        </div>

        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="grid min-w-0 gap-6">
            <CodeSnippet code={evaluateCall} />
            <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1">
              <div className="grid gap-1.5 border-arm-control border-l-2 pl-4">
                <dt className="font-medium text-foreground">As a Flag</dt>
                <dd className="text-muted-foreground text-sm leading-relaxed">
                  Change the rollout without redeploying. Each Environment has its own
                  configuration, so dev and prod move independently.
                </dd>
              </div>
              <div className="grid gap-1.5 border-arm-treatment border-l-2 pl-4">
                <dt className="font-medium text-foreground">As an Experiment</dt>
                <dd className="text-muted-foreground text-sm leading-relaxed">
                  The same call records an Exposure for each user, so results count exactly who saw
                  each Variant.
                </dd>
              </div>
            </dl>
          </div>

          <SplitVisual />
        </div>
      </div>
    </section>
  );
}
