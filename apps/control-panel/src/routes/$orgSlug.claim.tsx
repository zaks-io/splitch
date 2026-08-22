import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import { createFileRoute } from "@tanstack/react-router";
import { ClaimCeremony } from "#components/claim-ceremony";
import { loginRedirect } from "#lib/login-redirect";
import { loadCurrentSession } from "#lib/session-functions";

export const Route = createFileRoute("/$orgSlug/claim")({
  loader: async ({ location, params }) => {
    const result = await loadCurrentSession();
    if (result.kind === "unauthenticated") {
      throw loginRedirect(location.href);
    }
    const organization = result.session.orgs.find((org) => org.orgSlug === params.orgSlug);
    return organization ?? null;
  },
  component: ClaimRoute,
});

function ClaimRoute() {
  const organization = Route.useLoaderData();

  if (!organization) {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 py-8">
        <main className="mx-auto grid max-w-xl gap-6">
          <Alert variant="destructive">
            <AlertTitle>access_denied</AlertTitle>
            <AlertDescription>You are not a member of this Organization.</AlertDescription>
          </Alert>
        </main>
      </div>
    );
  }

  if (!organization.isProvisional) {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 py-8">
        <main className="mx-auto grid max-w-xl gap-6">
          <Alert>
            <AlertTitle>Organization already claimed</AlertTitle>
            <AlertDescription>
              This Organization no longer needs the claim ceremony.
            </AlertDescription>
          </Alert>
        </main>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <main className="mx-auto grid max-w-xl gap-6">
        <section className="grid gap-2">
          <h1 className="font-semibold text-3xl text-foreground">Claim Organization</h1>
          <p className="text-muted-foreground">
            Verify your email before this demo workspace expires {organization.demoExpiresAt}.
          </p>
        </section>
        <Card>
          <CardHeader>
            <CardTitle>Keep your work</CardTitle>
            <CardDescription>
              The claim ceremony converts this provisional Organization in place.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ClaimCeremony orgSlug={organization.orgSlug} />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
