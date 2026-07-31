export function CodeSnippet({ code }: { code: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-border bg-muted p-4 font-mono text-foreground text-sm leading-relaxed">
      <code>{code}</code>
    </pre>
  );
}
