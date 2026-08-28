import type { ErrorResponse } from "@splitch/contracts";
import type { AssignmentStoreReader, EvaluatePathDeps } from "@splitch/evaluation-core";
import { keyVersionOf, type SaltStore } from "@splitch/privacy";
import { errorResponse } from "./evaluation-error-response";

export interface AppIdentityAdmission {
  readonly appId: string;
  readonly identityVersion: string;
  readonly saltStore: SaltStore;
  readonly sourceSaltStore: SaltStore;
}

export class AppIdentityAdmissionError extends Error {
  constructor() {
    super("App identity generation changed during Evaluation");
    this.name = "AppIdentityAdmissionError";
  }
}

export async function admitAppIdentity(
  saltStore: SaltStore,
  appId: string,
): Promise<AppIdentityAdmission> {
  const identityVersion = await saltStore.currentKeyVersion(appId);
  return {
    appId,
    identityVersion,
    saltStore: pinSaltStore(saltStore, appId, identityVersion),
    sourceSaltStore: saltStore,
  };
}

export async function tryAdmitAppIdentity(
  saltStore: SaltStore,
  appId: string,
): Promise<
  | { readonly ok: true; readonly admission: AppIdentityAdmission }
  | { readonly ok: false; readonly error: ErrorResponse }
> {
  try {
    return { ok: true, admission: await admitAppIdentity(saltStore, appId) };
  } catch {
    return { ok: false, error: appIdentityAdmissionError() };
  }
}

async function assertAppIdentityAdmission(admission: AppIdentityAdmission): Promise<void> {
  try {
    if (
      (await admission.sourceSaltStore.currentKeyVersion(admission.appId)) !==
      admission.identityVersion
    ) {
      throw new AppIdentityAdmissionError();
    }
  } catch {
    throw new AppIdentityAdmissionError();
  }
}

export async function appIdentityAdmissionValidationError(
  admission: AppIdentityAdmission,
): Promise<ErrorResponse | null> {
  try {
    await assertAppIdentityAdmission(admission);
    return null;
  } catch {
    return appIdentityAdmissionError();
  }
}

export function admittedAssignmentStore(
  store: AssignmentStoreReader,
  admission: AppIdentityAdmission,
): AssignmentStoreReader {
  return {
    getAll: (input) =>
      guardedAssignmentCall(admission, input, () =>
        store.getAll({ ...input, identityVersion: admission.identityVersion }),
      ),
    put: (input) =>
      guardedAssignmentCall(admission, input, () =>
        store.put({ ...input, identityVersion: admission.identityVersion }),
      ),
    putHashed: (input) => {
      if (keyVersionOf(input.targetingKeyHash) !== admission.identityVersion) {
        return Promise.reject(new AppIdentityAdmissionError());
      }
      return guardedAssignmentCall(admission, input, () =>
        store.putHashed({ ...input, identityVersion: admission.identityVersion }),
      );
    },
  };
}

export function admittedEvaluatePathDeps<T extends EvaluatePathDeps>(
  deps: T,
  admission: AppIdentityAdmission,
): T {
  return {
    ...deps,
    assignmentStore: admittedAssignmentStore(deps.assignmentStore, admission),
  };
}

function appIdentityAdmissionError(): ErrorResponse {
  return errorResponse("SERVICE_UNAVAILABLE", "App identity reset is in progress");
}

function pinSaltStore(
  source: SaltStore,
  admittedAppId: string,
  identityVersion: string,
): SaltStore {
  const saltsFor = source.saltsFor?.bind(source);
  const assertScope = (appId: string) => {
    if (appId !== admittedAppId) throw new AppIdentityAdmissionError();
  };
  return {
    async currentKeyVersion(appId) {
      assertScope(appId);
      return identityVersion;
    },
    saltFor(appId, version) {
      assertScope(appId);
      return source.saltFor(appId, version);
    },
    async retainedKeyVersions(appId) {
      assertScope(appId);
      await assertCurrentSourceGeneration(source, appId, identityVersion);
      return source.retainedKeyVersions(appId);
    },
    saltsFor:
      saltsFor === undefined
        ? undefined
        : (appId, version) => {
            assertScope(appId);
            return saltsFor(appId, version);
          },
  };
}

async function guardedAssignmentCall<T>(
  admission: AppIdentityAdmission,
  input: { appId: string },
  run: () => Promise<T>,
): Promise<T> {
  if (input.appId !== admission.appId) throw new AppIdentityAdmissionError();
  await assertAppIdentityAdmission(admission);
  const result = await run();
  await assertAppIdentityAdmission(admission);
  return result;
}

async function assertCurrentSourceGeneration(
  source: SaltStore,
  appId: string,
  identityVersion: string,
): Promise<void> {
  try {
    if ((await source.currentKeyVersion(appId)) !== identityVersion) {
      throw new AppIdentityAdmissionError();
    }
  } catch {
    throw new AppIdentityAdmissionError();
  }
}
