import { revokeControlPanelConvexInstallation } from "#lib/integrations/control-plane-convex-functions";

export type ConvexOutcome = { kind: "done" } | { kind: "refused"; message: string };

export async function revokeConvexInstallation(input: {
  appId: string;
  environmentId: string;
  installationId: string;
}): Promise<ConvexOutcome> {
  const result = await revokeControlPanelConvexInstallation({ data: input });
  if (!result.ok) return { kind: "refused", message: result.error.message };
  return { kind: "done" };
}
