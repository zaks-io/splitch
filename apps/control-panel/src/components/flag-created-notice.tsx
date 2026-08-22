import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Link } from "@tanstack/react-router";
import { appHomeHref } from "#lib/app-shell-navigation";
import type { FlagsMatrixData } from "#lib/flags-matrix-data";
import { parityHint } from "#lib/parity-hints";
import { ParityNote } from "./parity-note";

export function FlagCreatedNotice({
  appSlug,
  createdKey,
  matrix,
  orgSlug,
}: {
  appSlug: string;
  createdKey: string;
  matrix: FlagsMatrixData;
  orgSlug: string;
}) {
  if (!matrix.rows.some((row) => row.definition.key === createdKey)) return null;

  return (
    <Alert data-flag-created-notice>
      <AlertTitle>
        <code>{createdKey}</code> created.
      </AlertTitle>
      <AlertDescription className="grid gap-3">
        <p>It is disabled in every Environment until you switch it on.</p>
        <ParityNote hint={parityHint("flag_config_update")} />
        <Link className="w-fit underline underline-offset-4" to={appHomeHref({ orgSlug, appSlug })}>
          Dismiss
        </Link>
      </AlertDescription>
    </Alert>
  );
}
