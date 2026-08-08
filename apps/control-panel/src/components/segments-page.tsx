import type {
  PanelSegment,
  UnparseablePanelSegment,
} from "@splitch/control-plane-sdk/panel-segments";
import { Button } from "@splitch/ui/components/button";
import { EmptyState } from "@splitch/ui/state/empty-state";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { type MutationErrorSurface, mutationErrorSurface } from "#lib/api";
import { deleteControlPanelSegment } from "#lib/control-plane-segment-functions";
import { parityHint } from "#lib/parity-hints";
import { ParityNote } from "./parity-note";
import { SegmentEditorDialog } from "./segment-editor-dialog";
import { SegmentMutationError } from "./segment-mutation-error";
import { SegmentsTable } from "./segments-table";

export function SegmentsPage({
  appId,
  environmentId,
  segments,
  unparseable,
}: {
  appId: string;
  environmentId: string;
  segments: PanelSegment[];
  unparseable: UnparseablePanelSegment[];
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

  const hasRows = segments.length > 0 || unparseable.length > 0;

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
            A Segment is a reusable set of Conditions (attribute / operator / value) that selects
            Entities for this App.
          </p>
        </div>
        {hasRows ? (
          <SegmentEditorDialog
            appId={appId}
            environmentId={environmentId}
            onDeleted={reread}
            onSaved={reread}
          />
        ) : null}
      </header>

      {unparseable.length > 0 ? (
        <UnparseableSegments
          appId={appId}
          environmentId={environmentId}
          onDeleted={reread}
          unparseable={unparseable}
        />
      ) : null}

      {segments.length > 0 ? (
        <SegmentsTable
          appId={appId}
          environmentId={environmentId}
          onDeleted={reread}
          onSaved={reread}
          segments={segments}
        />
      ) : null}

      {!hasRows ? (
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
      ) : null}
    </section>
  );
}

function UnparseableSegments({
  appId,
  environmentId,
  onDeleted,
  unparseable,
}: {
  appId: string;
  environmentId: string;
  onDeleted: () => void | Promise<void>;
  unparseable: UnparseablePanelSegment[];
}) {
  return (
    <div
      className="grid gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4"
      data-unparseable-segments={unparseable.length}
      role="alert"
    >
      <div className="grid gap-1">
        <p className="font-semibold text-destructive text-sm">
          {unparseable.length === 1
            ? "1 Segment could not be rendered"
            : `${unparseable.length} Segments could not be rendered`}
        </p>
        <p className="text-muted-foreground text-sm">
          These rows failed Panel validation. Healthy Segments stay listed below. Delete an
          unreadable Segment here, or fix it through the API.
        </p>
      </div>
      <ul className="grid gap-3">
        {unparseable.map((row) => (
          <li
            className="grid gap-2 rounded-md border border-border bg-background p-3"
            data-unparseable-segment-id={row.id ?? "unknown"}
            key={row.id ?? row.reason}
          >
            <p className="font-medium text-sm">{row.name ?? row.id ?? "Unnamed Segment"}</p>
            {row.id ? <p className="font-mono text-muted-foreground text-xs">{row.id}</p> : null}
            <p className="text-destructive text-sm">{row.reason}</p>
            {row.id ? (
              <UnparseableSegmentDelete
                appId={appId}
                environmentId={environmentId}
                onDeleted={onDeleted}
                segmentId={row.id}
                segmentName={row.name ?? row.id}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function UnparseableSegmentDelete({
  appId,
  environmentId,
  onDeleted,
  segmentId,
  segmentName,
}: {
  appId: string;
  environmentId: string;
  onDeleted: () => void | Promise<void>;
  segmentId: string;
  segmentName: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MutationErrorSurface | null>(null);

  async function remove() {
    if (!window.confirm(`Delete ${segmentName}? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await deleteControlPanelSegment({
        data: { appId, environmentId, segmentId },
      });
      if (result.ok) await onDeleted();
      else setError(mutationErrorSurface(result));
    } catch {
      setError({
        kind: "form",
        code: "TRANSPORT_FAILURE",
        message: "The Control Plane could not delete this Segment. Try again.",
        fields: [],
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      <div>
        <Button disabled={busy} onClick={() => void remove()} type="button" variant="destructive">
          Delete Segment
        </Button>
      </div>
      <SegmentMutationError error={error} />
    </div>
  );
}
