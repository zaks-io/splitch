import { parseIdentityResetCompletionBody } from "./holdover-write-app-deletion-input";
import { readAppDeletionSaga } from "./holdover-write-app-deletion-saga";
import { appInventoryStatus } from "./holdover-write-app-inventory";

const COMPLETED_IDENTITY_RESET_KEY = "completedIdentityResetId";
const PREPARED_IDENTITY_RESET_KEY = "preparedIdentityResetId";

interface CancellationResult {
  cancelled: boolean;
  done: boolean;
  entities: readonly unknown[];
  sagaPhase: string | null;
}

export async function prepareHoldoverWriteAppIdentityReset(
  storage: DurableObjectStorage,
  resetId: string,
): Promise<void> {
  await storage.put(PREPARED_IDENTITY_RESET_KEY, resetId);
  await storage.delete(COMPLETED_IDENTITY_RESET_KEY);
}

export async function completeHoldoverWriteAppIdentityReset(
  storage: DurableObjectStorage,
  request: Request,
  appId: string | undefined,
  activate: (identityVersion: string) => Promise<void>,
  cancel: (appId: string, resetId: string) => Promise<CancellationResult>,
): Promise<Response> {
  const parsed = await parseIdentityResetCompletionBody(request, appId);
  if (!parsed.ok) return parsed.response;
  if ((await storage.get<string>(COMPLETED_IDENTITY_RESET_KEY)) === parsed.generationId) {
    return completedResponse();
  }
  if ((await storage.get<string>(PREPARED_IDENTITY_RESET_KEY)) !== parsed.generationId) {
    return Response.json({ error: "App identity reset was not prepared" }, { status: 400 });
  }
  try {
    await activate(parsed.identityVersion);
    if (await canCompleteCancelledReset(storage)) {
      await markCompleted(storage, parsed.generationId);
      return completedResponse();
    }
    const result = await cancel(parsed.appId, parsed.generationId);
    if (result.cancelled && result.done) await markCompleted(storage, parsed.generationId);
    return Response.json(result);
  } catch (cause) {
    return Response.json(
      { error: cause instanceof Error ? cause.message : String(cause) },
      { status: 400 },
    );
  }
}

async function canCompleteCancelledReset(storage: DurableObjectStorage): Promise<boolean> {
  if ((await readAppDeletionSaga(storage)) !== null) return false;
  const status = await appInventoryStatus(storage);
  return !status.suppressed && status.entities.length === 0;
}

async function markCompleted(storage: DurableObjectStorage, resetId: string): Promise<void> {
  await storage.put(COMPLETED_IDENTITY_RESET_KEY, resetId);
  await storage.delete(PREPARED_IDENTITY_RESET_KEY);
}

function completedResponse(): Response {
  return Response.json({ cancelled: true, done: true, entities: [], sagaPhase: null });
}
