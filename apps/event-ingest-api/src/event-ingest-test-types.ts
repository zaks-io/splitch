export interface ExposurePayload {
  dedupKey: string;
  eventId: string;
  appId: string;
  environmentId: string;
  experimentId: string;
  runId: string;
  idType: string;
  targetingKeyHash: string;
  variantName: string;
  type: "exposure";
  sourceId: string;
  counterfactual: boolean;
  clientTimestamp: string;
  serverReceivedAt: string;
  ingestTs: string;
  sdkVersion: string;
}
