import { renderError } from "@splitch/worker-runtime";
import type { EnvironmentRow } from "./app-environment-model";

export function environmentExpiredError(environment: Pick<EnvironmentRow, "id" | "expiresAt">) {
  if (environment.expiresAt === null) throw new Error("permanent Environment cannot expire");
  return {
    code: "ENVIRONMENT_EXPIRED" as const,
    message: "Temporary Environment has expired; create a new Temporary Environment",
    details: {
      environmentId: environment.id,
      expiredAt: environment.expiresAt,
      recommendedAction: "CREATE_TEMPORARY_ENVIRONMENT" as const,
    },
  };
}

export function environmentHasExpired(
  environment: Pick<EnvironmentRow, "expiresAt">,
  now: string,
): boolean {
  return (
    environment.expiresAt !== null &&
    (!Number.isFinite(Date.parse(environment.expiresAt)) ||
      Date.parse(environment.expiresAt) <= Date.parse(now))
  );
}

export function environmentKindUnsupported(
  environment: Pick<EnvironmentRow, "id" | "expiresAt">,
  attemptedOp: string,
  requestId: string,
): Response {
  return renderError(
    {
      code: "ENVIRONMENT_KIND_UNSUPPORTED",
      message: "This operation is unavailable for this Environment kind",
      details: {
        environmentId: environment.id,
        temporary: environment.expiresAt !== null,
        attemptedOp,
      },
    },
    { requestId },
  );
}
