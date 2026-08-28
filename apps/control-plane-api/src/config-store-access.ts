import type { ExperimentConfigKV, FlagConfigKV, RunConfigKV } from "@splitch/contracts";
import type { ConfigStoreWriter } from "./config-store";
import type {
  EntityPrivacyLedgerInput,
  EntityPrivacyLedgerRecord,
} from "./config-store-app-identity-ledger";

export interface EvaluationFlagConfigRead {
  appId: string;
  environmentId: string;
  flagKey: string;
}

export interface EvaluationFlagConfigSnapshot {
  experiment: ExperimentConfigKV | null;
  flag: FlagConfigKV;
  run: RunConfigKV | null;
  version: number;
}

interface ConfigStoreLiveUpdates {
  connect(request: Request): Promise<Response>;
}

interface ConfigStoreDurableObjectStub extends ConfigStoreWriter {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  readFlagConfigForEvaluation(
    input: EvaluationFlagConfigRead,
  ): Promise<EvaluationFlagConfigSnapshot | null>;
  setLiveUpdatesAvailable(available: boolean): Promise<void>;
  readAppIdentity(appId: string): Promise<string | null>;
  putAppIdentityIfAbsent(appId: string, value: string): Promise<string>;
  resetCompromisedAppIdentity(appId: string, resetId: string): Promise<string>;
  assertAppIdentityTrafficAllowed(appId: string): Promise<void>;
  beginEntityPrivacy(appId: string): Promise<string>;
  recordEntityDeletionSuppression(
    appId: string,
    expectedVersion: string,
    input: { idType: string; targetingKeyHashes: readonly string[]; deleteBeforeTs: string },
  ): Promise<void>;
  recordEntityPrivacyCompletion(
    appId: string,
    expectedVersion: string,
    input: EntityPrivacyLedgerInput,
  ): Promise<EntityPrivacyLedgerRecord>;
}

export interface ConfigStoreDurableObjectNamespace {
  getByName(name: string): ConfigStoreDurableObjectStub;
}

export interface ConfigStoreAccess {
  writerFor(appId: string, environmentId: string): ConfigStoreWriter;
  liveUpdatesFor(appId: string, environmentId: string): ConfigStoreLiveUpdates;
  assertAppIdentityTrafficAllowed?(appId: string): Promise<void>;
  beginEntityPrivacy?(appId: string): Promise<string>;
  recordEntityDeletionSuppression?(
    appId: string,
    expectedVersion: string,
    input: { idType: string; targetingKeyHashes: readonly string[]; deleteBeforeTs: string },
  ): Promise<void>;
  recordEntityPrivacyCompletion?(
    appId: string,
    expectedVersion: string,
    input: EntityPrivacyLedgerInput,
  ): Promise<EntityPrivacyLedgerRecord>;
}

export interface AppIdentityResetAccess {
  resetCompromisedAppIdentity(appId: string, resetId: string): Promise<string>;
}

export function durableAppIdentityResetAccess(
  namespace: ConfigStoreDurableObjectNamespace,
): AppIdentityResetAccess {
  return {
    resetCompromisedAppIdentity(appId, resetId) {
      return namespace
        .getByName(`app-identity:${appId}`)
        .resetCompromisedAppIdentity(appId, resetId);
    },
  };
}

function configWriterName(appId: string, environmentId: string): string {
  return `${appId}:${environmentId}`;
}

export function durableConfigStoreAccess(
  namespace: ConfigStoreDurableObjectNamespace,
): ConfigStoreAccess & Required<Pick<ConfigStoreAccess, "assertAppIdentityTrafficAllowed">> {
  return {
    writerFor(appId, environmentId) {
      return namespace.getByName(configWriterName(appId, environmentId));
    },
    liveUpdatesFor(appId, environmentId) {
      return {
        connect(request) {
          return namespace.getByName(configWriterName(appId, environmentId)).fetch(request);
        },
      };
    },
    assertAppIdentityTrafficAllowed(appId) {
      return namespace.getByName(`app-identity:${appId}`).assertAppIdentityTrafficAllowed(appId);
    },
    beginEntityPrivacy(appId) {
      return namespace.getByName(`app-identity:${appId}`).beginEntityPrivacy(appId);
    },
    recordEntityDeletionSuppression(appId, expectedVersion, input) {
      return namespace
        .getByName(`app-identity:${appId}`)
        .recordEntityDeletionSuppression(appId, expectedVersion, input);
    },
    recordEntityPrivacyCompletion(appId, expectedVersion, input) {
      return namespace
        .getByName(`app-identity:${appId}`)
        .recordEntityPrivacyCompletion(appId, expectedVersion, input);
    },
  };
}
