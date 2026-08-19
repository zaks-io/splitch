/**
 * The typed-confirmation rule for deleting an App.
 *
 * Exact string equality, deliberately: nothing is trimmed, case-folded, or
 * matched against the App's display name. An operator who typed something close
 * enough to pass a lenient check was not confirming this App, and the whole
 * point of the ceremony is that the destruction is named and deliberate.
 *
 * One rule, used by both the submit button's enabled state and the handler, so
 * the button can never say yes to something the handler would refuse.
 */
export function isDeleteConfirmed(typed: string, appKey: string): boolean {
  return typed === appKey;
}
