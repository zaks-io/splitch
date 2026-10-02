import type { ErrorResponse, EvaluateAllEntry, EvaluateAllRequest } from "@splitch/contracts";
import { memoizeGetAll } from "./assignment/memoize-get-all";
import { evaluateAllFlag } from "./evaluate/accessor-paths";
import type { EvaluatePathDeps, EvaluatePathInput } from "./evaluate/evaluate-path-types";
import {
  exposureTicketRefreshWindow,
  type MintExposureTicketDeps,
} from "./evaluate/exposure-ticket";
import { entryFor } from "./evaluate-all-entry";
import { errorResponse } from "./evaluation-error-response";
import type { EvaluationUsageScope } from "./evaluation-usage";
import type { FlagConfig } from "./provider/provider";

export interface EvaluateAllResolveDeps extends EvaluatePathDeps {
  readonly exposureTicket: MintExposureTicketDeps;
}

export async function resolveAllEvaluations(
  body: EvaluateAllRequest,
  scope: EvaluationUsageScope,
  deps: EvaluateAllResolveDeps,
): Promise<
  | {
      ok: true;
      evaluations: Record<string, EvaluateAllEntry>;
      ticketRefreshWindow: number | null;
    }
  | { ok: false; error: ErrorResponse }
> {
  let flags: FlagConfig[];
  try {
    flags = await deps.provider.getFlags(scope.appId, scope.environmentId);
  } catch (cause) {
    deps.logger?.error("evaluate_all_get_flags_failed", { cause });
    return {
      ok: false,
      error: errorResponse("SERVICE_UNAVAILABLE", "provider config is temporarily unavailable"),
    };
  }

  const assignmentStore = memoizeGetAll(deps.assignmentStore);
  const pathDeps: EvaluatePathDeps = { ...deps, assignmentStore };
  const ticketNow = (deps.exposureTicket.now ?? (() => new Date()))();
  const ticketDeps: MintExposureTicketDeps = {
    ...deps.exposureTicket,
    now: () => ticketNow,
  };
  if (flags.some((flag) => flag.flagKey === "__proto__")) {
    return {
      ok: false,
      error: errorResponse(
        "UNSUPPORTED_OBJECT_KEY",
        'Flag Key "__proto__" cannot be included in Precomputed Evaluations',
      ),
    };
  }

  const entries = await Promise.all(
    flags.map(async (flag) => {
      const routeInput: EvaluatePathInput = {
        appId: scope.appId,
        environmentId: scope.environmentId,
        flagKey: flag.flagKey,
        evaluationContext: {
          targetingKey: body.targetingKey,
          idType: body.idType,
          attributes: body.attributes,
        },
      };
      const output = await evaluateAllFlag(routeInput, pathDeps);
      const entry = await entryFor(output.result, flag, ticketDeps);
      return [flag.flagKey, entry] as const;
    }),
  );
  const evaluations = Object.fromEntries(entries) as Record<string, EvaluateAllEntry>;
  const hasExposureTicket = entries.some(([, entry]) => entry.exposureTicket !== null);

  return {
    ok: true,
    evaluations,
    ticketRefreshWindow: hasExposureTicket ? exposureTicketRefreshWindow(ticketNow) : null,
  };
}
