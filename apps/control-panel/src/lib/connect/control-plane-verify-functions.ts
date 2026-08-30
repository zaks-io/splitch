import { env as workerEnv } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { controlPanelMutationBindings } from "#lib/shared/bindings";
import { createControlPanelSettingsClient } from "#lib/settings/control-plane-settings";
import {
  type PanelVerifyOutcome,
  panelVerifyOutcome,
  verifyFlagWithClientKey,
} from "#lib/connect/panel-verify";
import { loadSessionFromRequest } from "#lib/sessions/session-refresh";

const VerifyFlagSchema = z.object({
  appId: z.string().min(1),
  environmentId: z.string().min(1),
  flagKey: z.string().min(1),
  targetingKey: z.string().min(1),
});

type VerifyFailure = {
  ok: false;
  status: number;
  error: { code: string; message: string };
};

export type VerifyFlagResult = { ok: true; data: PanelVerifyOutcome } | VerifyFailure;

/**
 * Resolve a Flag for one targeting key without recording an Exposure.
 *
 * The Panel Worker holds the credential; the browser never sees a key it did not
 * already have on screen, and a locked Client Key still verifies because the
 * call leaves from the server (ADR-0034).
 */
export const verifyControlPanelFlag = createServerFn({ method: "POST" })
  .validator((data: unknown) => VerifyFlagSchema.parse(data))
  .handler(async ({ data }): Promise<VerifyFlagResult> => {
    const bindings = controlPanelMutationBindings(workerEnv);
    const loaded = await loadSessionFromRequest(bindings, getRequest());
    if (!loaded.ok) {
      return failure(401, "UNAUTHORIZED", "authentication required");
    }

    const settings = await createControlPanelSettingsClient(
      bindings.CONTROL_PLANE_API,
      { actorId: loaded.session.userId, sessionExpiresAt: loaded.session.expiresAt },
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    ).read({ appId: data.appId, environmentId: data.environmentId });

    if (!settings.ok) {
      return failure(settings.status, settings.error.code, settings.error.message);
    }

    const details = await verifyFlagWithClientKey({
      clientKey: settings.data.clientKey.keyMaterial,
      endpoint: bindings.EVALUATION_API_ORIGIN,
      flagKey: data.flagKey,
      targetingKey: data.targetingKey,
    });
    return { ok: true, data: panelVerifyOutcome(details) };
  });

function failure(status: number, code: string, message: string): VerifyFailure {
  return { ok: false, status, error: { code, message } };
}
