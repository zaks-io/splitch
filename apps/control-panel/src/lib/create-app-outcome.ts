import type { ErrorResponse } from "@splitch/contracts";
import { type MutationErrorSurface, mutationErrorSurface } from "./api";

/**
 * Three outcomes, not two (mirrors `create-organization-outcome.ts`).
 *
 * The App is either created or it is not, and refreshing the caller's session
 * afterwards is a separate thing that can fail on its own. Folding a resync
 * failure into "could not create" (SPL-203) tells the user to retry a mutation
 * that already succeeded, which collides with the App key on the next attempt
 * (`apps_org_key_unique`). `created-session-stale` is loud about what happened
 * and offers the action that actually works.
 *
 * It lives here rather than beside the server function so the browser half can
 * import the shape without dragging `cloudflare:workers` in with it.
 */
export type CreateControlPanelAppResult =
  | { readonly outcome: "created"; readonly appSlug: string }
  | {
      readonly outcome: "created-session-stale";
      readonly appSlug: string;
      readonly reason: string;
    }
  | { readonly outcome: "refused"; readonly status: number; readonly error: ErrorResponse };

/** What the form should do next. One decision table, so it can be read at once. */
export type CreateAppEffect =
  | { readonly kind: "created"; readonly appSlug: string }
  | { readonly kind: "session-stale"; readonly appSlug: string }
  | { readonly kind: "failed"; readonly failure: MutationErrorSurface };

/**
 * Maps a settled call — including one that threw — onto the effect it deserves.
 *
 * The load-bearing line is the middle one: an App that was created but whose
 * session could not be refreshed is NOT a failure, and must never be rendered as
 * one (SPL-203). Anything this function cannot recognise is a failure, never a
 * success, so a shape change fails loud rather than silently reporting a create
 * that may not have happened.
 */
export function createAppEffect(input: unknown): CreateAppEffect {
  if (isOutcome(input, "created")) return { kind: "created", appSlug: input.appSlug };
  if (isOutcome(input, "created-session-stale")) {
    return { kind: "session-stale", appSlug: input.appSlug };
  }
  return { kind: "failed", failure: createAppFailure(input) };
}

function isOutcome<K extends CreateControlPanelAppResult["outcome"]>(
  input: unknown,
  outcome: K,
): input is Extract<CreateControlPanelAppResult, { outcome: K }> {
  if (typeof input !== "object" || input === null) return false;
  const candidate = input as { outcome?: unknown; appSlug?: unknown };
  return candidate.outcome === outcome && typeof candidate.appSlug === "string";
}

type Refusal = Extract<CreateControlPanelAppResult, { outcome: "refused" }>;

function createAppFailure(input: unknown): MutationErrorSurface {
  const refusal = asRefusal(input);
  if (refusal) {
    return mutationErrorSurface({ ok: false, status: refusal.status, error: refusal.error });
  }
  return {
    kind: "form",
    message: "The Control Plane could not create this App. Try again.",
    fields: [],
  };
}

function asRefusal(input: unknown): Refusal | null {
  if (typeof input !== "object" || input === null) return null;
  const candidate = input as Partial<Refusal>;
  return candidate.outcome === "refused" && candidate.error && typeof candidate.status === "number"
    ? (candidate as Refusal)
    : null;
}

/**
 * The exact decision SPL-203 fixes: once `create` has returned ok, a resync
 * failure settles as `created-session-stale`, never as a refusal. Extracted out
 * of the server function so the decision is unit-testable without the Worker
 * bindings, session, and TanStack server-fn ceremony the real resync call needs.
 */
export async function settleAfterCreate(
  appSlug: string,
  resync: () => Promise<void>,
): Promise<CreateControlPanelAppResult> {
  try {
    await resync();
  } catch (cause) {
    return {
      outcome: "created-session-stale",
      appSlug,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
  return { outcome: "created", appSlug };
}
