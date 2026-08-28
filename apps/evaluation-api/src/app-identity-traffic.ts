import type { ErrorResponse } from "@splitch/contracts";
import type { SaltStore } from "@splitch/privacy";
import { errorResponse } from "./evaluation-error-response";

export async function appIdentityTrafficError(
  saltStore: SaltStore,
  appId: string,
): Promise<ErrorResponse | null> {
  try {
    await saltStore.currentKeyVersion(appId);
    return null;
  } catch {
    return errorResponse("SERVICE_UNAVAILABLE", "App identity reset is in progress");
  }
}
