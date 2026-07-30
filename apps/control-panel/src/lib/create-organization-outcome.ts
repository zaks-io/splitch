import type { ErrorResponse } from "@splitch/contracts";
import { resyncRemedy, type ResyncRemedy } from "./resync-remedy";

/**
 * Three outcomes, not two.
 *
 * The Organization is either created or it is not, and refreshing the caller's
 * session afterwards is a separate thing that can fail on its own. Folding a
 * resync failure into "could not create" (SPL-203) tells the user to retry a
 * mutation that already succeeded, which on the next attempt collides with the
 * handle they just took. `created-session-stale` is loud about what happened and
 * offers the action that actually works.
 *
 * It lives here rather than beside the server function so the browser half can
 * import the shape without dragging `cloudflare:workers` in with it.
 */
export type CreateControlPanelOrganizationResult =
  | { readonly outcome: "created"; readonly orgSlug: string }
  | {
      readonly outcome: "created-session-stale";
      readonly orgSlug: string;
      readonly reason: string;
      readonly remedy: ResyncRemedy;
    }
  | { readonly outcome: "refused"; readonly status: number; readonly error: ErrorResponse };

export interface CreateOrganizationFailure {
  readonly title: string;
  /** The Worker's own words, never paraphrased. */
  readonly message: string;
  /** An action that can actually succeed from here (ADR-0036). */
  readonly nextStep: string | null;
  /** Set when the refusal is about the handle, so the field carries it too. */
  readonly slugMessage: string | undefined;
}

type Refusal = Extract<CreateControlPanelOrganizationResult, { outcome: "refused" }>;

/** What the form should do next. One decision table, so it can be read at once. */
export type CreateOrganizationEffect =
  | { readonly kind: "created"; readonly orgSlug: string }
  | {
      readonly kind: "session-stale";
      readonly orgSlug: string;
      readonly reason: string;
      readonly remedy: ResyncRemedy;
    }
  | { readonly kind: "failed"; readonly failure: CreateOrganizationFailure };

/**
 * Maps a settled call — including one that threw — onto the effect it deserves.
 *
 * The load-bearing line is the middle one: an Organization that was created but
 * whose session could not be refreshed is NOT a failure, and must never be
 * rendered as one (SPL-203). Anything this function cannot recognise is a
 * failure, never a success, so a shape change fails loud rather than silently
 * reporting a create that may not have happened.
 */
export function createOrganizationEffect(input: unknown): CreateOrganizationEffect {
  if (isCreated(input)) return { kind: "created", orgSlug: input.orgSlug };
  const stale = asStale(input);
  if (stale) {
    return {
      kind: "session-stale",
      orgSlug: stale.orgSlug,
      reason: stale.reason,
      remedy: stale.remedy,
    };
  }
  return { kind: "failed", failure: createOrganizationFailure(input) };
}

function isCreated(
  input: unknown,
): input is Extract<CreateControlPanelOrganizationResult, { outcome: "created" }> {
  if (typeof input !== "object" || input === null) return false;
  const candidate = input as { outcome?: unknown; orgSlug?: unknown };
  return candidate.outcome === "created" && typeof candidate.orgSlug === "string";
}

type Stale = Extract<CreateControlPanelOrganizationResult, { outcome: "created-session-stale" }>;

function asStale(input: unknown): Stale | null {
  if (typeof input !== "object" || input === null) return null;
  const candidate = input as Partial<Stale>;
  return candidate.outcome === "created-session-stale" &&
    typeof candidate.orgSlug === "string" &&
    typeof candidate.reason === "string" &&
    (candidate.remedy === "reauth" || candidate.remedy === "retry")
    ? (candidate as Stale)
    : null;
}

/**
 * Every failure branch names what happened AND an action that can succeed.
 * "Try again" is only ever offered where trying again could work: a taken handle
 * is told to pick another, an expired session is told to sign in. Telling a user
 * to retry something that can only fail the same way is the quiet version of a
 * silent fallback.
 */
export function createOrganizationFailure(
  input: CreateControlPanelOrganizationResult | unknown,
): CreateOrganizationFailure {
  const refusal = asRefusal(input);
  if (!refusal) {
    return {
      title: "Organization not created",
      message: "The Control Plane could not be reached, so nothing was created.",
      nextStep: "Check your connection and create again.",
      slugMessage: undefined,
    };
  }
  return describeRefusal(refusal.status, refusal.error);
}

function describeRefusal(status: number, error: ErrorResponse): CreateOrganizationFailure {
  if (error.code === "SLUG_CONFLICT") {
    return {
      title: "That URL handle is taken",
      message: error.message,
      nextStep: "Handles are unique across splitch. Pick a different one and create again.",
      slugMessage: error.message,
    };
  }
  if (status === 401) {
    return {
      title: "Your session has ended",
      message: error.message,
      nextStep: "Sign in again, then create the Organization.",
      slugMessage: undefined,
    };
  }
  if (status === 403) {
    return {
      title: "Not allowed to create an Organization",
      message: error.message,
      nextStep: null,
      slugMessage: undefined,
    };
  }
  if (status === 400 && error.code === "VALIDATION_ERROR") {
    return {
      title: "Organization not created",
      message: error.message,
      nextStep: "Correct the highlighted field and create again.",
      slugMessage: slugIssue(error),
    };
  }
  return {
    title: "Organization not created",
    message: error.message,
    nextStep: "Nothing was created. Create again in a moment.",
    slugMessage: undefined,
  };
}

function slugIssue(error: ErrorResponse): string | undefined {
  if (error.code !== "VALIDATION_ERROR") return undefined;
  return error.details.issues.find((issue) => issue.path.includes("slug"))?.message;
}

function asRefusal(input: unknown): Refusal | null {
  if (typeof input !== "object" || input === null) return null;
  const candidate = input as Partial<Refusal>;
  return candidate.outcome === "refused" && candidate.error && typeof candidate.status === "number"
    ? (candidate as Refusal)
    : null;
}

/**
 * The exact decision SPL-203 fixes, mirrored from `create-app-outcome.ts`:
 * once `create` has returned ok, a resync failure settles as
 * `created-session-stale`, never as a refusal.
 */
export async function settleAfterCreate(
  orgSlug: string,
  resync: () => Promise<void>,
): Promise<CreateControlPanelOrganizationResult> {
  try {
    await resync();
  } catch (cause) {
    return {
      outcome: "created-session-stale",
      orgSlug,
      reason: cause instanceof Error ? cause.message : String(cause),
      remedy: resyncRemedy(cause),
    };
  }
  return { outcome: "created", orgSlug };
}
