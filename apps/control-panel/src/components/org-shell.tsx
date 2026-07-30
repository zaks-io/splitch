import { type ReactNode, useEffect, useState } from "react";
import { ShellMenu, ShellMenuExternalLink, ShellMenuLink } from "#components/shell-menu";
import type { OrgMembership } from "#lib/session";

export interface OrgShellOrg {
  readonly orgId: string;
  readonly orgSlug: string;
}

/**
 * The Org shell frame — `/{orgSlug}/...`. Its top bar carries the org switcher
 * (present only for multi-org users) and the user menu. There is deliberately no
 * Environment switcher here: Environments live under an App, one level down.
 */
export function OrgShell({
  children,
  orgRole,
  orgSlug,
  orgs,
  userId,
}: {
  children: ReactNode;
  orgRole: OrgMembership["orgRole"];
  orgSlug: string;
  orgs: readonly OrgShellOrg[];
  userId: string;
}) {
  // Create App is a client action, so the frame states when it is actually
  // usable rather than leaving a rendered-but-inert control (the same contract
  // the App shell publishes).
  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => setIsHydrated(true), []);

  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
      data-hydrated={isHydrated ? "true" : "false"}
      data-org={orgSlug}
      data-org-shell="ready"
    >
      <header className="flex flex-col gap-4 border-border border-b bg-muted/30 px-4 py-4 sm:flex-row sm:items-end sm:justify-between lg:px-6">
        <div className="grid min-w-0 gap-1">
          <p className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
            Organization
          </p>
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-primary" />
            <h1 className="truncate font-semibold text-base text-foreground">{orgSlug}</h1>
            <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
              {orgRole}
            </span>
          </div>
        </div>

        <div className="grid gap-2 sm:auto-cols-[minmax(11rem,14rem)] sm:grid-flow-col">
          {orgs.length > 1 ? (
            <ShellMenu label="Organization" value={orgSlug}>
              {orgs.map((org) => (
                <ShellMenuLink href={`/${encodeURIComponent(org.orgSlug)}`} key={org.orgId}>
                  {org.orgSlug}
                </ShellMenuLink>
              ))}
            </ShellMenu>
          ) : null}
          <ShellMenu label="Signed in" value={userId}>
            <ShellMenuExternalLink href="/auth/logout">Sign out</ShellMenuExternalLink>
          </ShellMenu>
        </div>
      </header>

      <main className="min-w-0 bg-background p-5 sm:p-7">{children}</main>
    </div>
  );
}
