import { CopyableCode } from "./copyable-code";

export function CodeAgentPrompt({
  prompt,
  testId,
  title = "Implement with your code agent",
}: {
  prompt: string;
  testId: string;
  title?: string;
}) {
  return (
    <section
      aria-labelledby={`${testId}-title`}
      className="grid gap-3 rounded-lg border border-border bg-card p-4"
      data-testid={testId}
    >
      <div className="grid gap-1">
        <h3 className="font-medium text-sm" id={`${testId}-title`}>
          {title}
        </h3>
        <p className="text-muted-foreground text-sm leading-6">
          Copy this into your code editor. It carries the current Splitch configuration and tells
          the agent to fit the implementation to your repository.
        </p>
      </div>
      <CopyableCode label={`${title} prompt`} testId={`${testId}-text`} value={prompt} />
      <p className="text-muted-foreground text-xs leading-5">
        The prompt points the agent at the current Splitch implementation contract before it edits.
      </p>
    </section>
  );
}
