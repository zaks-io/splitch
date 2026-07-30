import type { FlagDetailView } from "#lib/flag-detail-view";
import { FlagDetailDefinition } from "./flag-detail-definition";
import { FlagDetailEnvConfig } from "./flag-detail-env-config";
import { FlagDetailExperimentBanner } from "./flag-detail-experiment-banner";

/**
 * The read-complete Flag detail screen.
 *
 * Order is the message: this Environment's Configuration first, the App-level
 * definition after it as a labeled sub-area (screen-inventory.md). The banner sits
 * above both because it changes how everything below it can be read.
 */
export function FlagDetailPage({ scopeHref, view }: { scopeHref: string; view: FlagDetailView }) {
  const env = view.env;

  return (
    <section className="grid gap-6" aria-labelledby="flag-detail-title">
      <header className="grid gap-2">
        <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.16em]">
          <a
            className="underline underline-offset-4 hover:no-underline"
            href={`${scopeHref}/flags`}
          >
            Flags
          </a>{" "}
          / {env} Environment
        </p>
        <h1
          className="font-semibold text-3xl text-foreground tracking-tight"
          id="flag-detail-title"
        >
          {view.name}
        </h1>
        <p className="font-mono text-muted-foreground text-sm">{view.key}</p>
        {view.description ? (
          <p className="max-w-2xl text-muted-foreground text-sm leading-6">{view.description}</p>
        ) : null}
      </header>

      {view.controllingExperiment ? (
        <FlagDetailExperimentBanner experiment={view.controllingExperiment} scopeHref={scopeHref} />
      ) : null}

      <FlagDetailEnvConfig view={view} />
      <FlagDetailDefinition view={view} />
    </section>
  );
}
