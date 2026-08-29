import { Link } from "@tanstack/react-router";
import {
  type DocumentedErrorCode,
  documentedCodesBySurface,
  errorCodeMarker,
  errorDocs,
  errorSurfaces,
  surfaceBlurbs,
  surfaceLabels,
} from "../docs/errors";

function CodeRow({ code }: { code: DocumentedErrorCode }) {
  const marker = errorCodeMarker(code);

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
    <div className="grid gap-8">
      {errorSurfaces.map((surface) => (
        <section className="grid gap-3" id={surface} key={surface}>
          <div className="grid gap-1">
            <h2 className="font-display font-semibold text-foreground text-xl tracking-tight">
              {surfaceLabels[surface]}{" "}
              <span className="font-normal text-muted-foreground text-sm tabular-nums">
                ({bySurface[surface].length})
              </span>
            </h2>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {surfaceBlurbs[surface]}
            </p>
          </div>
          <ul className="grid">
            {bySurface[surface].map((code) => (
              <CodeRow code={code} key={code} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
