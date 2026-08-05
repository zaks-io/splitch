import { Link } from "@tanstack/react-router";
import {
  type DocumentedErrorCode,
  documentedCodesBySurface,
  errorDocs,
  httpStatusForDocumentedCode,
} from "../docs/errors";

const surfaces = [
  {
    key: "api" as const,
    title: "API",
    blurb: "Returned on the wire by the control plane and the edge, with an HTTP status.",
  },
  {
    key: "sdk" as const,
    title: "SDK",
    blurb: "Thrown by @splitch/sdk at construction, before any request goes out.",
  },
  {
    key: "cli" as const,
    title: "CLI",
    blurb: "Raised by splitch itself. Each one carries the process exit code it returns.",
  },
];

function CodeRow({ code }: { code: DocumentedErrorCode }) {
  const status = httpStatusForDocumentedCode(code);
  const exitCode = errorDocs[code].exitCode;
  const marker =
    status !== null ? String(status) : exitCode !== undefined ? `exit ${exitCode}` : "";

  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-border border-b py-2 last:border-b-0">
      <Link
        className="font-mono text-foreground text-sm underline underline-offset-4"
        params={{ code }}
        to="/docs/error/$code"
      >
        {code}
      </Link>
      {marker && (
        <span className="font-mono text-muted-foreground text-xs tabular-nums">{marker}</span>
      )}
      <span className="min-w-48 flex-1 text-muted-foreground text-sm leading-relaxed">
        {errorDocs[code].cause}
      </span>
    </li>
  );
}

export function ErrorCodeIndex() {
  const bySurface = documentedCodesBySurface();

  return (
    <section className="grid gap-8" id="errors">
      <div className="grid gap-2">
        <h2 className="font-display font-semibold text-2xl text-foreground tracking-tight">
          Errors
        </h2>
        <p className="max-w-2xl text-muted-foreground leading-relaxed">
          Every code any splitch surface can emit resolves to a page at{" "}
          <span className="font-mono text-foreground">/docs/error/{"{code}"}</span>. Error messages
          print that URL, so a failure you have never seen is one click from its cause and its fix.
        </p>
      </div>

      {surfaces.map((surface) => (
        <div className="grid gap-3" key={surface.key}>
          <div className="grid gap-1">
            <h3 className="font-medium text-foreground">
              {surface.title}{" "}
              <span className="font-normal text-muted-foreground text-sm tabular-nums">
                ({bySurface[surface.key].length})
              </span>
            </h3>
            <p className="text-muted-foreground text-sm leading-relaxed">{surface.blurb}</p>
          </div>
          <ul className="grid">
            {bySurface[surface.key].map((code) => (
              <CodeRow code={code} key={code} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
