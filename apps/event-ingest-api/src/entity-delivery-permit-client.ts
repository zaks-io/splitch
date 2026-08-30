import { entityStub, type EntityMetricPrivacyNamespace } from "./entity-metric-privacy";

export async function completeEntityDeliveryPermit(
  namespace: EntityMetricPrivacyNamespace | undefined,
  identity: { appId: string; idType: string; entityFamilyHash: string },
  deliveryId: string,
): Promise<void> {
  const response = await entityStub(namespace, identity).fetch(
    "https://entity-privacy.local/complete-row",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId }),
    },
  );
  if (!response.ok) throw new Error(`Entity identity completion returned ${response.status}`);
}
