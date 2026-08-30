import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { mutationErrorSurface } from "#lib/shared/api";
import {
  loadControlPanelApprovalRequest,
  promoteControlPanelFlagConfig,
  reviewControlPanelApprovalRequest,
} from "#lib/flags/control-plane-flag-mutations";
import type { FlagDetailView } from "#lib/flags/flag-detail-view";
import { flagWriteDecision } from "#lib/flags/flag-write-decision";
import { type GatedWritePhase, gatedWritePhase } from "#lib/approval/gated-write-phase";
import type { PromotionRow } from "#lib/promotions/promotion-diff";
import {
  type PromotionDependency,
  promotionDependencies,
  promotionSelect,
  type PromotionSelect,
  promotionSummary,
  selectedRows,
} from "#lib/promotions/promotion-selection";

/**
 * The Promotion screen's one write path.
 *
 * The ticket's invariant — the diff shown IS the diff submitted — is held here by
 * construction rather than by agreement: `request` is built once from `preview`,
 * the screen renders that same object as its payload, and `submit` sends it
 * unmodified. There is no second traversal of the rows on the way to the wire, so
 * there is nothing for a preview and a request to disagree about.
 */

export type FlagPromotionScope = {
  appId: string;
  /** The Environment being changed. Its Policy governs; it delegates the write. */
  targetEnvironmentId: string;
  targetEnv: string;
  fromEnvironmentId: string;
  sourceEnv: string;
  flagId: string;
  /** Variant id -> name, so the gate can name what a Targeting Rule serves. */
  variantLabels: Readonly<Record<string, string>>;
};

export type PromotionRequest = {
  readonly appId: string;
  readonly targetEnvironmentId: string;
  readonly fromEnvironmentId: string;
  readonly flagId: string;
  readonly select: PromotionSelect;
  readonly variantLabels: Readonly<Record<string, string>>;
};

export type FlagPromotion = {
  readonly state: GatedWritePhase;
  readonly busy: boolean;
  readonly selected: ReadonlySet<string>;
  /** Exactly the rows the screen renders as ticked. */
  readonly preview: readonly PromotionRow[];
  /** The payload, built from `preview` and sent verbatim. */
  readonly request: PromotionRequest;
  readonly summary: string;
  readonly dependencies: readonly PromotionDependency[];
  toggle(rowId: string): void;
  replaceSelection(ids: ReadonlySet<string>): void;
  submit(): Promise<void>;
  confirm(): Promise<void>;
  dismiss(): void;
};

export function useFlagPromotion(
  {
    scope,
    rows,
    source,
    target,
  }: {
    scope: FlagPromotionScope;
    rows: readonly PromotionRow[];
    source: FlagDetailView;
    target: FlagDetailView;
  },
  newKey: () => string = defaultKey,
): FlagPromotion {
  const router = useRouter();
  const [state, setState] = useState<GatedWritePhase>({ phase: "idle" });
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());

  const preview = useMemo(() => selectedRows(rows, selected), [rows, selected]);
  const request = useMemo(() => promotionRequest(scope, preview), [preview, scope]);
  const summary = useMemo(
    () => promotionSummary(preview, scope.sourceEnv, scope.targetEnv),
    [preview, scope.sourceEnv, scope.targetEnv],
  );
  const dependencies = useMemo(
    () => promotionDependencies(rows, selected, source, target),
    [rows, selected, source, target],
  );

  const toggle = useCallback((rowId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(rowId)) next.add(rowId);
      return next;
    });
  }, []);

  const replaceSelection = useCallback((ids: ReadonlySet<string>) => setSelected(new Set(ids)), []);

  const submit = useCallback(async () => {
    setState({ phase: "saving" });
    const decision = flagWriteDecision(
      await promoteControlPanelFlagConfig({ data: { ...request, idempotencyKey: newKey() } }),
    );
    if (decision.kind === "applied") {
      await router.invalidate();
      setState({ phase: "applied", approvalRequest: decision.approvalRequest });
      return;
    }
    if (decision.kind === "refused") {
      setState({ phase: "refused", summary, error: decision.error });
      return;
    }
    const gateRequest = await loadControlPanelApprovalRequest({
      data: {
        appId: scope.appId,
        approvalRequestId: decision.approvalRequestId,
        variantLabels: { ...scope.variantLabels },
      },
    });
    setState(gatedWritePhase(summary, gateRequest));
  }, [newKey, request, router, scope.appId, scope.variantLabels, summary]);

  const confirm = useCallback(async () => {
    if (state.phase !== "gate") return;
    setState({ ...state, confirming: true, error: null });
    const reviewed = await reviewControlPanelApprovalRequest({
      data: {
        appId: scope.appId,
        approvalRequestId: state.request.id,
        action: "approve_and_apply",
        idempotencyKey: newKey(),
        variantLabels: { ...scope.variantLabels },
      },
    });
    if (!reviewed.ok) {
      setState({ ...state, confirming: false, error: mutationErrorSurface(reviewed) });
      return;
    }
    await router.invalidate();
    setState({ phase: "applied", approvalRequest: reviewed.data });
  }, [newKey, router, scope.appId, scope.variantLabels, state]);

  const dismiss = useCallback(() => setState({ phase: "idle" }), []);

  return {
    state,
    busy: state.phase === "saving" || (state.phase === "gate" && state.confirming),
    selected,
    preview,
    request,
    summary,
    dependencies,
    toggle,
    replaceSelection,
    submit,
    confirm,
    dismiss,
  };
}

/**
 * The single constructor of the promote payload, from the ticked rows and nothing
 * else. Exported so the equality the screen depends on is directly assertable.
 */
export function promotionRequest(
  scope: FlagPromotionScope,
  preview: readonly PromotionRow[],
): PromotionRequest {
  return {
    appId: scope.appId,
    targetEnvironmentId: scope.targetEnvironmentId,
    fromEnvironmentId: scope.fromEnvironmentId,
    flagId: scope.flagId,
    select: promotionSelect(preview),
    variantLabels: scope.variantLabels,
  };
}

function defaultKey(): string {
  return crypto.randomUUID();
}
