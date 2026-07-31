/**
 * Which Environments a Promotion can pull FROM, resolved from the session's own
 * navigation rather than from the URL.
 *
 * A source the operator cannot see in their scope is not a source, so an
 * unresolvable `?from=` is reported as unresolvable instead of quietly falling
 * back to some other Environment — a Promotion that silently changed its source
 * would diff one pair and promote another (ADR-0036).
 */

export type PromotionSourceOption = { readonly env: string; readonly environmentId: string };

type AppScopeNavigation = {
  orgs: Array<{
    apps: Array<{
      appId: string;
      environments: readonly { environmentId: string; env: string }[];
    }>;
  }>;
};

export function promotionSources(
  navigation: AppScopeNavigation,
  appId: string,
  targetEnv: string,
): readonly PromotionSourceOption[] {
  const app = navigation.orgs
    .flatMap((org) => org.apps)
    .find((candidate) => candidate.appId === appId);

  return (app?.environments ?? [])
    .filter((environment) => environment.env !== targetEnv)
    .map((environment) => ({ env: environment.env, environmentId: environment.environmentId }));
}

/**
 * The requested source, or the first available one when none was requested.
 * `undefined` means the request named an Environment that is not a source here.
 */
export function resolvePromotionSource(
  sources: readonly PromotionSourceOption[],
  requested: string | undefined,
): PromotionSourceOption | undefined {
  if (requested === undefined) return sources[0];
  return sources.find((source) => source.env === requested);
}
