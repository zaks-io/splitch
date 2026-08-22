import { scopedHref } from "#lib/app-shell-navigation";
import {
  attentionLabel,
  type EnvironmentAttentionState,
  type OrgAppListEnvironment,
} from "#lib/org-app-list";

/**
 * The App name links to App home. This pill is the explicit Environment entry
 * and carries that Environment's Experiment-health marker.
 *
 * The health marker is `aria-hidden` and described through `aria-describedby`
 * rather than nested text, so the link's accessible name stays the Environment
 * name while the reason still reaches a screen reader.
 */
export function EnvironmentLink({
  appSlug,
  attention,
  environment,
  orgSlug,
}: {
  appSlug: string;
  attention: EnvironmentAttentionState;
  environment: OrgAppListEnvironment;
  orgSlug: string;
}) {
  const label = attentionLabel(attention, environment.name);
  const describedById = label ? `attention-${environment.environmentId}` : undefined;

  return (
    <span className="relative inline-flex">
      <a
        className="flex min-h-10 items-center gap-2 rounded-md border border-border bg-background px-3 py-2 font-medium text-foreground text-sm transition-colors hover:border-primary/50 hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
        data-environment-link={environment.env}
        href={scopedHref({ appSlug, env: environment.env, orgSlug })}
        {...(describedById ? { "aria-describedby": describedById } : {})}
      >
        {environment.name}
      </a>
      <AttentionMarker attention={attention} environmentId={environment.environmentId} />
      {label && describedById ? (
        <span className="sr-only" id={describedById}>
          {label}
        </span>
      ) : null}
    </span>
  );
}

const MARKER_CLASSES = {
  attention: "bg-destructive",
  unknown: "bg-amber-500 dark:bg-amber-400",
} as const;

function AttentionMarker({
  attention,
  environmentId,
}: {
  attention: EnvironmentAttentionState;
  environmentId: string;
}) {
  if (attention.kind !== "attention" && attention.kind !== "unknown") return null;
  return (
    <span
      aria-hidden="true"
      className={`-top-1 -right-1 absolute size-2.5 rounded-full ring-2 ring-card ${MARKER_CLASSES[attention.kind]}`}
      data-attention-environment-id={environmentId}
      data-attention-state={attention.kind}
    />
  );
}
