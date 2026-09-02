import { quickstartSteps } from "../docs/quickstart";
import { CodeSnippet } from "./code-snippet";

export function QuickstartSteps() {
  return (
    <ol className="grid gap-10">
      {quickstartSteps.map((step, index) => (
        <li
          className="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-10"
          key={step.title}
        >
          <div className="grid content-start gap-2">
            <p className="font-mono text-arm-control text-xs uppercase tracking-wide">
              Step {index + 1} / {quickstartSteps.length}
            </p>
            <h2 className="font-display font-semibold text-2xl text-foreground tracking-tight">
              {step.title}
            </h2>
            <p className="text-muted-foreground text-sm leading-relaxed">{step.body}</p>
          </div>
          <div className="min-w-0">
            <CodeSnippet code={step.code} />
          </div>
        </li>
      ))}
    </ol>
  );
}
