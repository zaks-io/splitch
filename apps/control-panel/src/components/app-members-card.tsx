import type { AppMember } from "@splitch/contracts";
import type { PanelAppAccessCandidate } from "@splitch/control-plane-sdk/panel-app-settings";
import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@splitch/ui/components/table";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { AppSettingsCapabilities } from "#lib/app-settings-capabilities";
import { refreshAppSettings } from "#lib/app-settings-query";
import { AppMemberGrantForm } from "./app-member-grant-form";
import { AppMemberRow } from "./app-member-row";

/**
 * Who has access to this App, which is a different list from who is in the
 * Organization: Org membership is the precondition for App access, never the
 * grant itself.
 *
 * Every gate here is presentation only. The Worker rechecks live App membership
 * on each call and refuses on its own terms; a refusal is shown verbatim rather
 * than reduced to a generic failure (ADR-0023, ADR-0036).
 */
export function AppMembersCard({
  appId,
  candidates,
  capabilities,
  members,
}: {
  appId: string;
  candidates?: PanelAppAccessCandidate[];
  capabilities: AppSettingsCapabilities;
  members: AppMember[];
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();

  async function refresh() {
    await refreshAppSettings(queryClient, { appId });
  }

  return (
    <Card data-testid="app-members-card">
      <CardHeader>
        <CardTitle>App access</CardTitle>
        <CardDescription>
          Who can work in this App, and at what role. Access is granted to people who are already in
          this Organization.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error ? (
          <Alert data-testid="app-members-error" variant="destructive">
            <AlertTitle>App access unchanged</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Person</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Granted</TableHead>
              <TableHead aria-label="Actions" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <AppMemberRow
                appId={appId}
                capabilities={capabilities}
                key={member.userId}
                member={member}
                onChanged={refresh}
                onError={setError}
              />
            ))}
          </TableBody>
        </Table>

        {capabilities.canGrantAccess ? (
          <AppMemberGrantForm
            appId={appId}
            candidates={candidates}
            capabilities={capabilities}
            onError={setError}
            onGranted={refresh}
          />
        ) : (
          <p className="text-muted-foreground text-sm" data-testid="app-grant-not-permitted">
            Owners and Admins of this App can grant access to it.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
