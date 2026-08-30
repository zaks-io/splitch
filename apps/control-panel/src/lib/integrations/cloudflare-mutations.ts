import { revokeControlPanelCloudflareInstallation } from "#lib/integrations/control-plane-cloudflare-functions";

export type CloudflareOutcome = { kind: "done" } | { kind: "refused"; message: string };

export async function revokeCloudflareInstallation(input: {
  appId: string;
  environmentId: string;
  installationId: string;
}): Promise<CloudflareOutcome> {
  const result = await revokeControlPanelCloudflareInstallation({ data: input });
  if (!result.ok) return { kind: "refused", message: result.error.message };
  return { kind: "done" };
}
