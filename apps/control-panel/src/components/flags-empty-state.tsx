import { EmptyState } from "@splitch/ui/state/empty-state";
import { CreateFlagDialog } from "./create-flag-dialog";

export function FlagsEmptyState({
  appId,
  environmentId,
}: {
  appId: string;
  environmentId: string;
}) {
  return (
    <EmptyState
      action={<CreateFlagDialog appId={appId} environmentId={environmentId} />}
      className="min-h-72"
      description={
        <span>
          A Flag is a named toggle with Variants. Start here, or use{" "}
          <code>splitch flags create</code> / <code>flags_create</code>.
        </span>
      }
      title="Create your first Flag"
    />
  );
}
