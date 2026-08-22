import { EmptyState } from "@splitch/ui/state/empty-state";
import { parityHint } from "#lib/parity-hints";
import { CreateFlagDialog } from "./create-flag-dialog";
import { ParityNote } from "./parity-note";

export function FlagsEmptyState({
  appId,
  environmentId,
  onClosedAfterCreate,
  settingsHref,
}: {
  appId: string;
  environmentId: string;
  onClosedAfterCreate?: (key: string) => void;
  settingsHref: string;
}) {
  return (
    <EmptyState
      action={
        <CreateFlagDialog
          appId={appId}
          environmentId={environmentId}
          onClosedAfterCreate={onClosedAfterCreate}
          settingsHref={settingsHref}
        />
      }
      className="min-h-72"
      description="A Flag is a named toggle with Variants. Create one here, then wire it into your code with the Client Key and snippet handed to you next."
      secondaryAction={<ParityNote hint={parityHint("flags_create")} />}
      title="Create your first Flag"
    />
  );
}
