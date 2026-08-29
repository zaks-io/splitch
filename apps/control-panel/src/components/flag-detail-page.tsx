import type { FlagDetailView } from "#lib/flag-detail-view";
import { flagImplementationConfigurationFromView } from "#lib/flag-implementation-configuration";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { renderFlagImplementationPrompt } from "#lib/implementation-prompt";
import { useFlagEditing } from "#lib/use-flag-editing";
import { CodeAgentPrompt } from "./code-agent-prompt";
import { FlagDetailDefinition } from "./flag-detail-definition";
import { FlagDetailEnvConfig } from "./flag-detail-env-config";
import { FlagDetailExperimentBanner } from "./flag-detail-experiment-banner";
import { GatedWriteOutcome } from "./gated-write-outcome";

/**
 * The Flag detail screen.
 *
 * Order is the message: this Environment's Configuration first, the App-level
 * definition after it as a labeled sub-area (screen-inventory.md). The banner sits
 * above both because it changes how everything below it can be read.
 *
 * One editing controller for the whole screen and one outcome region, because
 * there is one write path. Every control proposes to the Worker and waits; none
 * of them renders a value the Worker has not confirmed.
 */
export function FlagDetailPage({
  appId,
  clientKey,
  environmentId,
  scopeHref,
  view,
  promotionSourceEnv,
}: {
  appId: string;
  clientKey?: string;
  environmentId: string;
  scopeHref: string;
  view: FlagDetailView;
  /** The Environment this one would pull from by default; absent when it is the only one. */
  promotionSourceEnv?: string;
}) {
  const env = view.env;
  const editing = useFlagEditing({
    appId,
    environmentId,
    flagId: view.flagId,
    variantLabels: Object.fromEntries(view.catalog.map((variant) => [variant.id, variant.name])),
  });

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
        {promotionSourceEnv ? (
          <p className="pt-1">
            <a
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-muted-foreground text-xs transition-colors hover:border-foreground/30 hover:text-foreground"
              data-flag-promote-entry={promotionSourceEnv}
              href={`${scopeHref}/flags/${encodeURIComponent(view.key)}/promote?from=${encodeURIComponent(promotionSourceEnv)}`}
            >
              Promote from <span className="font-mono">{promotionSourceEnv}</span>
            </a>
          </p>
        ) : null}
      </header>

      {view.controllingExperiment ? (
        <FlagDetailExperimentBanner experiment={view.controllingExperiment} scopeHref={scopeHref} />
      ) : null}

      <GatedWriteOutcome
        ungatedCopy="Saved. This Environment's Policy does not gate this change, so no Approval Request was needed."
        write={editing}
      />
      <FlagDetailEnvConfig editing={editing} view={view} />
      <FlagDetailDefinition editing={editing} view={view} />
      {clientKey ? (
        <CodeAgentPrompt
          prompt={renderFlagImplementationPrompt({
            clientKey,
            environment: view.env,
            flag: flagImplementationConfigurationFromView(view),
          })}
          testId="flag-detail-code-agent-prompt"
        />
      ) : (
        <Alert variant="destructive">
          <AlertTitle>Code-agent prompt unavailable</AlertTitle>
          <AlertDescription>
            The public Client Key could not be loaded. Reload this page or copy it from Environment
            settings before implementing this Flag.
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
}
