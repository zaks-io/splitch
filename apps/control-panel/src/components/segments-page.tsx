import type { PanelSegment } from "@splitch/control-plane-sdk/panel-segments";
import { EmptyState } from "@splitch/ui/state/empty-state";
import { useRouter } from "@tanstack/react-router";
import { parityHint } from "#lib/parity-hints";
import { ParityNote } from "./parity-note";
import { SegmentEditorDialog } from "./segment-editor-dialog";
import { SegmentsTable } from "./segments-table";

export function SegmentsPage({
  appId,
  environmentId,
  segments,
}: {
  appId: string;
  environmentId: string;
  segments: PanelSegment[];
}) {
  const router = useRouter();

  /*
   * Re-read, never patch: `segments` is route-loader data with no React Query
   * cache in front of it, so invalidating the route is the whole read-back.
   * Splicing the write's own response into local state would show the operator
   * a row the Panel never read back from the Control Plane -- the disguised
   * default ADR-0036 forbids, and the reason no surface here keeps a local
   * mirror of server state (ADR-0023).
   */
  async function reread() {
    await router.invalidate();
  }

  return (
    <section aria-labelledby="segments-title" className="grid gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid gap-2">
          <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.16em]">
            Defined once, available in every Environment
          </p>
          <h1 className="font-semibold text-3xl text-foreground tracking-tight" id="segments-title">
            Segments (App-level)
          </h1>
          <p className="max-w-2xl text-muted-foreground text-sm leading-6">
            Define reusable Condition sets for this App. Targeting Rules and Experiments can
            reference them from any Environment.
          </p>
        </div>
        {segments.length > 0 ? (
          <SegmentEditorDialog
            appId={appId}
            environmentId={environmentId}
            onDeleted={reread}
            onSaved={reread}
          />
        ) : null}
      </header>

      {segments.length > 0 ? (
        <SegmentsTable
          appId={appId}
          environmentId={environmentId}
          onDeleted={reread}
          onSaved={reread}
          segments={segments}
        />
      ) : (
        <EmptyState
          action={
            <SegmentEditorDialog
              appId={appId}
              environmentId={environmentId}
              onDeleted={reread}
              onSaved={reread}
            />
          }
          description="A Segment is a reusable set of Conditions (attribute / operator / value) that selects traffic."
          secondaryAction={<ParityNote hint={parityHint("segments_create")} />}
          title="Create your first Segment"
        />
      )}
    </section>
  );
}
