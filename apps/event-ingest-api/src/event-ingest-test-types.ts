export interface ExposurePayload {
  dedupKey: string;
  eventId: string;
  appId: string;
  environmentId: string;
  experimentId: string;
  runId: string;
  idType: string;
  targetingKeyHash: string;
  entityFamilyHash: string;
  variantName: string;
  type: "exposure" | "activation";
  sourceId: string;
  counterfactual: boolean;
  clientTimestamp: string;
  exposureAt: string;
  serverReceivedAt: string;
  ingestTs: string;
  sdkVersion: string;
}
