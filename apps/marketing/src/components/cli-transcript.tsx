import type { TranscriptLine, TranscriptSession } from "../content/agent-session";

/* A transcript, not a mock UI: every line is the CLI's real contract, kept with
   its source in content/agent-session.ts. */
export function CliTranscript({ session }: { session: TranscriptSession }) {
  return (
    <figure
      aria-label={session.label}
      className="grid min-w-0 gap-4 rounded-xl border border-border bg-card p-5 shadow-md sm:p-6"
    >
      <figcaption className="font-mono text-muted-foreground text-xs">{session.caption}</figcaption>
      <pre className="overflow-x-auto font-mono text-xs leading-relaxed sm:text-[13px]">
        <code>
          {session.lines.map((line) => (
            <TranscriptRow key={`${line.kind}:${line.text}`} line={line} />
          ))}
        </code>
      </pre>
    </figure>
  );
}

function TranscriptRow({ line }: { line: TranscriptLine }) {
  if (line.kind === "command") {
    return (
      <span className="block whitespace-pre text-foreground">
        <span aria-hidden="true" className="select-none text-muted-foreground">
          ${" "}
        </span>
        {line.text}
      </span>
    );
  }
  const tone = line.kind === "result" ? "text-arm-treatment-foreground" : "text-muted-foreground";
  return (
    <span className={`mb-3 block whitespace-pre-wrap break-words last:mb-0 ${tone}`}>
      {line.text}
    </span>
  );
}
