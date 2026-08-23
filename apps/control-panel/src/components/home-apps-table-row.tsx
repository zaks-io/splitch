import { Badge } from "@splitch/ui/components/badge";
import { TableCell, TableRow } from "@splitch/ui/components/table";
import { AppSplitMark } from "#components/app-split-mark";
import { EnvironmentLink } from "#components/environment-link";
import { appHomeHref } from "#lib/app-shell-navigation";
import {
  type AppAttentionSeverity,
  appAttentionSeverity,
  appAttentionSummary,
  environmentAttention,
  type OrgAppListApp,
} from "#lib/org-app-list";

/**
 * Absolute severity tones: measured-clear green, unknown amber, attention via
 * the destructive variant. `no_data` stays the neutral secondary badge: those
 * Environments were read but nothing was measured, so no color is claimed.
 */
const BADGE_TONE_CLASSES: Record<AppAttentionSeverity, string | undefined> = {
  clear: "bg-success-muted text-success-foreground",
  attention: undefined,
  no_data: undefined,
  unknown: "bg-warning-muted text-warning-foreground",
  unavailable: "bg-warning-muted text-warning-foreground",
};

export function HomeAppsTableRow({ app, orgSlug }: { app: OrgAppListApp; orgSlug: string }) {
  const severity = appAttentionSeverity(app);
  const unavailable = severity === "unavailable";

  return (
    <TableRow data-app-row={app.appSlug}>
      <TableCell>
        {app.environments.length > 0 ? (
          <a
            className="group inline-flex min-w-0 items-center gap-2 font-mono font-medium text-foreground"
            href={appHomeHref({ orgSlug, appSlug: app.appSlug })}
          >
            <AppSplitMark />
            <span className="truncate underline underline-offset-4 group-hover:no-underline">
              {app.appSlug}
            </span>
          </a>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-2 font-mono font-medium text-foreground">
            <AppSplitMark />
            <span className="truncate">{app.appSlug}</span>
          </span>
        )}
      </TableCell>
      <TableCell>
        {app.environments.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {app.environments.map((environment) => (
              <EnvironmentLink
                appSlug={app.appSlug}
                attention={environmentAttention(app.attention, environment.environmentId)}
                environment={environment}
                key={environment.environmentId}
                orgSlug={orgSlug}
              />
            ))}
          </div>
        ) : (
          <p className="max-w-72 whitespace-normal text-destructive text-sm" role="alert">
            This App has no Environments. It cannot be opened until one exists.
          </p>
        )}
      </TableCell>
      <TableCell>{flagsCell(app)}</TableCell>
      <TableCell>
        <Badge
          className={BADGE_TONE_CLASSES[severity]}
          data-app-attention-severity={severity}
          data-app-attention-summary={app.appSlug}
          variant={severity === "attention" ? "destructive" : "secondary"}
        >
          {appAttentionSummary(app)}
          {unavailable && app.attention.kind === "unavailable" ? `: ${app.attention.message}` : ""}
        </Badge>
      </TableCell>
    </TableRow>
  );
}

function flagsCell(app: OrgAppListApp) {
  if (app.flags.kind === "unavailable") {
    return (
      <span
        className="text-warning-foreground"
        data-app-flags-state="unavailable"
        title={app.flags.message}
      >
        Unavailable
      </span>
    );
  }
  return (
    <span title={app.flags.truncated ? "More Flags than one read returns" : undefined}>
      {app.flags.count}
      {app.flags.truncated ? "+" : ""}
    </span>
  );
}
