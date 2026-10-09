import { Button } from "@splitch/ui/components/button";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

export function CodeSnippet({ code }: { code: string }) {
  const [copiedCode, setCopiedCode] = useState<string>();
  const [copyError, setCopyError] = useState<string>();
  const [copying, setCopying] = useState(false);
  const copied = copiedCode === code;

  async function copy() {
    setCopying(true);
    try {
      await navigator.clipboard.writeText(code);
      setCopyError(undefined);
      setCopiedCode(code);
    } catch {
      setCopiedCode(undefined);
      setCopyError("The browser could not copy the code. Select the text and copy it manually.");
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className="min-w-0 rounded-lg border border-border bg-muted text-foreground">
      <div className="flex justify-end px-4 pt-3">
        <Button
          aria-label="Copy code"
          disabled={copying}
          focusableWhenDisabled
          onClick={copy}
          size="sm"
          type="button"
          variant="outline"
        >
          {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          <span>{copying ? "Copying..." : copied ? "Copied" : "Copy"}</span>
        </Button>
        <span className="sr-only" role="status">
          {copying ? "Copying code." : copied ? "Code copied to clipboard." : ""}
        </span>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap p-4 font-mono text-sm leading-relaxed [overflow-wrap:anywhere]">
        <code>{code}</code>
      </pre>
      {copyError ? (
        <p className="px-4 pb-4 text-destructive text-sm" role="alert">
          {copyError}
        </p>
      ) : null}
    </div>
  );
}
