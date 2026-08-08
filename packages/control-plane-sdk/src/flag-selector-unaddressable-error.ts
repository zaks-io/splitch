/**
 * A Flag key that cannot be placed in a URL path segment without the WHATWG
 * parser rewriting the request onto a different resource (collection root, App
 * root, or an empty segment). Percent-encoding is not a fix: `%2e` / `%2e%2e`
 * collapse the same way. Fail loud here rather than silently mis-address.
 */
export class FlagSelectorUnaddressableError extends Error {
  constructor(selector: string) {
    super(
      `control-plane-sdk: Flag selector ${JSON.stringify(selector)} cannot be addressed as a path segment`,
    );
    this.name = "FlagSelectorUnaddressableError";
  }
}
