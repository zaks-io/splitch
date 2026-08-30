import type { ParityHint } from "#lib/connect/parity-hints";

/** "Or do it from the terminal / from an agent" — the same operation, other skins. */
export function ParityNote({ hint }: { hint: ParityHint }) {
  return (
    <span className="text-muted-foreground text-xs" data-testid="parity-note">
      <code className="rounded bg-muted px-2 py-1 font-mono">{hint.cli}</code>{" "}
      <span className="px-1">/</span>{" "}
      <code className="rounded bg-muted px-2 py-1 font-mono">{hint.mcp}</code>
    </span>
  );
}
