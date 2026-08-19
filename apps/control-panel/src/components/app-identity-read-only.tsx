import type { App } from "@splitch/contracts";
import { CardContent } from "@splitch/ui/components/card";

/**
 * What a Member sees where Owners and Admins get the rename form.
 *
 * Deliberately not a disabled copy of that form: an input nobody can type in
 * still looks like an input, and the read-only shape says what is true without
 * making a working control look broken.
 */
export function AppIdentityReadOnly({ app, slugHelp }: { app: App; slugHelp: string }) {
  return (
    <CardContent className="grid gap-5" data-testid="app-identity-read-only">
      <div className="grid gap-1">
        <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          App name
        </span>
        <span className="text-sm">{app.name}</span>
      </div>
      <div className="grid gap-1">
        <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          URL slug
        </span>
        <code className="w-fit rounded bg-muted px-1.5 py-0.5 text-sm">{app.key}</code>
        <span className="text-muted-foreground text-xs">{slugHelp}</span>
      </div>
      <p className="text-muted-foreground text-sm">
        Owners and Admins of this App can change its name and URL slug.
      </p>
    </CardContent>
  );
}
