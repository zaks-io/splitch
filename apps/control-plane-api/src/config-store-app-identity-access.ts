import type {
  EntityPrivacyLedgerInput,
  EntityPrivacyLedgerRecord,
} from "./config-store-app-identity-ledger";

export interface ConfigStoreAppIdentityDurableObjectStub {
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

interface ConfigStoreAppIdentityNamespace {
  getByName(name: string): ConfigStoreAppIdentityDurableObjectStub;
}

export interface ConfigStoreAppIdentityAccess {
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
  namespace: ConfigStoreAppIdentityNamespace,
): AppIdentityResetAccess {
  return {
    resetCompromisedAppIdentity(appId, resetId) {
      return identityStub(namespace, appId).resetCompromisedAppIdentity(appId, resetId);
    },
  };
}

export function durableConfigStoreAppIdentityAccess(
  namespace: ConfigStoreAppIdentityNamespace,
): Required<ConfigStoreAppIdentityAccess> {
  return {
    assertAppIdentityTrafficAllowed(appId) {
      return identityStub(namespace, appId).assertAppIdentityTrafficAllowed(appId);
    },
    beginEntityPrivacy(appId) {
      return identityStub(namespace, appId).beginEntityPrivacy(appId);
    },
    recordEntityDeletionSuppression(appId, expectedVersion, input) {
      return identityStub(namespace, appId).recordEntityDeletionSuppression(
        appId,
        expectedVersion,
        input,
      );
    },
    recordEntityPrivacyCompletion(appId, expectedVersion, input) {
      return identityStub(namespace, appId).recordEntityPrivacyCompletion(
        appId,
        expectedVersion,
        input,
      );
    },
  };
}

function identityStub(namespace: ConfigStoreAppIdentityNamespace, appId: string) {
  return namespace.getByName(`app-identity:${appId}`);
}
