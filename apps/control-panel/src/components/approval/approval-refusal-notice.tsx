import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import type { MutationErrorSurface } from "#lib/api";

/**
 * A Worker refusal, rendered as itself.
 *
 * Never collapsed into "something went wrong": the structured `code` and its
 * details are the only thing that tells an operator what to do next, and a
 * generic message is a disguised default (ADR-0036). The remedy line is derived
 * from the refusal, so it never suggests an action the operator cannot take.
 */
export function ApprovalRefusalNotice({ error }: { error: MutationErrorSurface }) {
  return (
    <Alert variant="destructive" data-refusal-code={error.code}>
      <AlertTitle className="font-mono text-xs uppercase tracking-[0.14em]">
        {error.code}
      </AlertTitle>
      <AlertDescription className="grid gap-2">
        <p className="leading-6">{error.message}</p>
        {error.fields.length > 0 ? (
          <ul className="grid gap-1">
            {error.fields.map((field) => (
              <li key={`${field.field}:${field.message}`}>
                <span className="font-mono text-xs">{field.field}</span> — {field.message}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs leading-5" data-refusal-remedy="true">
          {remedy(error.code)}
        </p>
      </AlertDescription>
    </Alert>
  );
}

/**
 * One line per refusal the Flag Configuration write path can produce, and a
 * deliberately honest fallback. Inventing a remedy for an unknown code would send
 * the operator somewhere useless, which is worse than saying it is unexpected.
 */
function remedy(code: string): string {
  switch (code) {
    case "VARIANT_NOT_AVAILABLE":
      return "Make that Variant available in this Environment first, then apply this change.";
    case "APPROVAL_REQUEST_STALE":
      return "The Flag Configuration changed since this proposal was written. Close this and propose the change again against the current state.";
    case "APPROVAL_REQUEST_RESOLVED":
      return "This Approval Request was already reviewed. Close this and re-read the Flag.";
    case "APPROVAL_REVIEW_FORBIDDEN":
      return "This Environment's Policy requires a different reviewer. Ask an App admin who did not propose this change to review it.";
    case "APPROVAL_APPLICATION_FAILED":
      return "The Review was recorded but application did not complete. The Approval Request stays pending; inspect the failure before retrying the Review.";
    case "RUN_FROZEN":
    case "DECISION_LOCKED":
      return "A running Experiment owns this field. End its Run before changing it here.";
    case "UNAUTHORIZED":
      return "Your session has expired. Sign in again.";
    case "FORBIDDEN":
      return "Your role in this App does not allow this change.";
    case "VALIDATION_ERROR":
      return "Correct the highlighted values and try again.";
    default:
      return "This refusal is not one this screen expects. Nothing was changed; report the code above.";
  }
}
