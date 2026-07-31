import { Button } from "@splitch/ui/components/button";
import { useState } from "react";

/**
 * A block of text the developer is meant to take with them.
 *
 * Copy failure is surfaced rather than swallowed: a button that silently copies
 * nothing is the exact class of quiet failure ADR-0036 forbids.
 */
export function CopyableCode({
  label,
  testId,
  value,
  wrap = false,
}: {
  label: string;
  testId: string;
  value: string;
  /**
   * Wrap instead of scrolling. A multi-line snippet reads better scrolling, but
   * a single long token — a Client Key — must be readable in full without
   * dragging, because eyeballing it is the whole point of showing it.
   */
  wrap?: boolean;
}) {
  const [copyLabel, setCopyLabel] = useState("Copy");
  const [copyError, setCopyError] = useState<string>();

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopyError(undefined);
      setCopyLabel("Copied");
    } catch {
      setCopyError("The browser blocked the copy. Select the text and copy it manually.");
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-sm">{label}</span>
        <Button
          aria-label={`Copy ${label}`}
          onClick={copy}
          size="sm"
          type="button"
          variant="outline"
        >
          {copyLabel}
        </Button>
      </div>
      <pre
        className={`min-w-0 rounded-lg bg-muted px-3 py-2 text-xs leading-5 ${
          wrap ? "whitespace-pre-wrap break-all" : "overflow-x-auto"
        }`}
        data-testid={testId}
      >
        <code>{value}</code>
      </pre>
      {copyError ? (
        <p className="text-destructive text-xs" role="alert">
          {copyError}
        </p>
      ) : null}
    </div>
  );
}
