import { Badge } from "@splitch/ui/components/badge";
import { TableCell, TableRow } from "@splitch/ui/components/table";
import { EnvironmentLink } from "#components/environment-link";
import { appHomeHref } from "#lib/app-shell-navigation";
import {
  appAttentionSeverity,
  appAttentionSummary,
  environmentAttention,
  type OrgAppListApp,
} from "#lib/org-app-list";

export function HomeAppsTableRow({ app, orgSlug }: { app: OrgAppListApp; orgSlug: string }) {
  const severity = appAttentionSeverity(app);
  const unavailable = severity === "unavailable";

  return (
    <TableRow data-app-row={app.appSlug}>
      <TableCell>
        {app.environments.length > 0 ? (
          <a
            className="font-mono font-medium text-foreground underline underline-offset-4 hover:no-underline"
            href={appHomeHref({ orgSlug, appSlug: app.appSlug })}
          >
            {app.appSlug}
          </a>
        ) : (
          <span className="font-mono font-medium text-foreground">{app.appSlug}</span>
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
          className={
            severity === "unknown" || unavailable ? "text-amber-600 dark:text-amber-400" : undefined
          }
          data-app-attention-severity={severity}
          data-app-attention-summary={app.appSlug}
          variant={
            severity === "attention"
              ? "destructive"
              : severity === "clear"
                ? "secondary"
                : "outline"
          }
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
        className="text-amber-600 dark:text-amber-400"
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
