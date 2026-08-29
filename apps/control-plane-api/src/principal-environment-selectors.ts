/**
 * Environment keys are unique within an App, so one key selector on the
 * principal-wide Flag read fans out to the matching Environment in every App
 * the principal can read. The App-scoped Flag reads resolve their selectors in
 * the path-selector rewrite, which cannot serve a route with no App axis.
 */
export class EnvironmentSelectorMissError extends Error {
  readonly selector: string;

  constructor(selector: string) {
    super(`no readable Environment matches selector ${selector}`);
    this.name = "EnvironmentSelectorMissError";
    this.selector = selector;
  }
}

interface EnvironmentIdentity {
  readonly id: string;
  readonly key: string;
}

/**
 * A selector that matches nothing anywhere in the principal's App set is a
 * miss, not an empty hydration; hydrating zero Configurations for a typo reads
 * to an agent as "these Flags have no Configuration".
 */
export function resolveEnvironmentSelectors(
  environments: readonly EnvironmentIdentity[],
  selectors: readonly string[],
): string[] {
  const resolved = new Set<string>();
  for (const selector of selectors) {
    const matches = environments.filter(
      (environment) => environment.id === selector || environment.key === selector,
    );
    if (matches.length === 0) throw new EnvironmentSelectorMissError(selector);
    for (const match of matches) resolved.add(match.id);
  }
  return [...resolved];
}
