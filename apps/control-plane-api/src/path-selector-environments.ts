import type { ErrorResponse } from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import type { EnvironmentRow } from "./app-environment-model";

const APP_ID_PREFIX = "app_";
const ENVIRONMENT_ID_PREFIX = "env_";

export async function resolveEnvironment(
  repo: Repository,
  appId: string | undefined,
  selector: string | undefined,
  forceCanonicalId: boolean,
  requireMatch = false,
  notFoundCode: "APP_NOT_FOUND" | "ENVIRONMENT_NOT_FOUND" = "APP_NOT_FOUND",
  requireRow = false,
): Promise<
  | { ok: true; environmentId?: string; row?: EnvironmentRow | null }
  | { ok: false; error: ErrorResponse }
> {
  if (selector === undefined) return { ok: true };
  if (!appId?.startsWith(APP_ID_PREFIX)) return failure("APP_NOT_FOUND", "app not found");
  if (forceCanonicalId && selector.startsWith(ENVIRONMENT_ID_PREFIX)) {
    return resolveCanonicalEnvironment(repo, appId, selector, requireRow, notFoundCode);
  }
  // Legacy keys can have the same `env_` shape as canonical IDs. One scoped OR
  // query is required to detect that collision without silently choosing a
  // plausible wrong Environment; it also avoids the old two-read ID-miss path.
  // The full row is carried to Environment GET so it can reuse this read.
  const candidates = await repo.identity.findEnvironmentSelectorCandidates(
    appScope(appId),
    selector,
  );
  if (
    candidates.length === 0 &&
    selector.startsWith(ENVIRONMENT_ID_PREFIX) &&
    !requireMatch &&
    !requireRow
  ) {
    return { ok: true, row: null };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      error: {
        code: "SELECTOR_AMBIGUOUS",
        message: `Environment selector "${selector}" matches more than one Environment`,
        details: {
          candidates: candidates.map(({ environmentId, environmentKey }) => ({
            environmentId,
            environmentKey,
          })),
          recommendedAction: "USE_CANONICAL_ID",
        },
      },
    };
  }
  // Path selectors keep APP_NOT_FOUND so a caller cannot use a nested route to
  // disclose whether an Environment exists outside the authorized App. Flag-read
  // query filters run after the App resolved and passed authorization, so their
  // miss names the actual filter with ENVIRONMENT_NOT_FOUND.
  const environment = candidates[0];
  return environment
    ? {
        ok: true,
        environmentId: environment.environmentId,
        row: environment.environment,
      }
    : failure(
        notFoundCode,
        notFoundCode === "ENVIRONMENT_NOT_FOUND" ? "environment not found" : "app not found",
      );
}

async function resolveCanonicalEnvironment(
  repo: Repository,
  appId: string,
  selector: string,
  requireRow: boolean,
  notFoundCode: "APP_NOT_FOUND" | "ENVIRONMENT_NOT_FOUND",
) {
  if (!requireRow) return { ok: true as const };
  const row = await repo.identity.getEnvironment(appScope(appId), selector);
  return row
    ? { ok: true as const, environmentId: row.id, row }
    : failure(notFoundCode, "environment not found");
}

export async function resolveEnvironmentSelectors(
  repo: Repository,
  appId: string | undefined,
  selectors: readonly string[] | undefined,
): Promise<{ ok: true; environmentIds?: string[] } | { ok: false; error: ErrorResponse }> {
  if (!selectors) return { ok: true };
  if (!appId?.startsWith(APP_ID_PREFIX)) return failure("APP_NOT_FOUND", "app not found");
  const candidates = await repo.identity.findEnvironmentSelectorCandidatesForSelectors(
    appScope(appId),
    selectors,
  );
  const environmentIds: string[] = [];
  for (const selector of selectors) {
    const matches = candidates.filter(
      (candidate) => candidate.environmentId === selector || candidate.environmentKey === selector,
    );
    if (matches.length > 1) {
      return {
        ok: false,
        error: {
          code: "SELECTOR_AMBIGUOUS",
          message: `Environment selector "${selector}" matches more than one Environment`,
          details: { candidates: matches, recommendedAction: "USE_CANONICAL_ID" },
        },
      };
    }
    const environment = matches[0];
    if (!environment) return failure("ENVIRONMENT_NOT_FOUND", "environment not found");
    environmentIds.push(environment.environmentId);
  }
  return { ok: true, environmentIds };
}

function failure(
  code: "APP_NOT_FOUND" | "ENVIRONMENT_NOT_FOUND" | "FLAG_NOT_FOUND",
  message: string,
): { ok: false; error: ErrorResponse } {
  return { ok: false, error: { code, message, details: {} } };
}
