import { Alert, AlertAction, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";

export interface ProvisionalOrgBannerProps {
  claimHref: string;
  demoExpiresAt: string;
}

export function ProvisionalOrgBanner({ claimHref, demoExpiresAt }: ProvisionalOrgBannerProps) {
  return (
    <Alert
      className="mb-4 border-destructive/40 bg-destructive/5"
      data-testid="provisional-org-banner"
    >
      <AlertTitle>Demo Organization expires {formatExpiry(demoExpiresAt)}</AlertTitle>
      <AlertDescription>Claim it to keep your work.</AlertDescription>
      <AlertAction>
        <Button
          render={<a href={claimHref}>Claim Organization</a>}
          size="sm"
          variant="destructive"
        />
      </AlertAction>
    </Alert>
  );
}

function formatExpiry(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
