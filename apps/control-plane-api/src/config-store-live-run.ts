import { envScope } from "@splitch/db";
import { clearLiveRunPointer, writeLiveRunPointer } from "./config-store-kv.js";
import type { ConfigStoreDeps } from "./config-store-shared.js";

export interface LiveRunPointerInput {
  appId: string;
  environmentId: string;
  experimentId: string;
  runId: string;
}

export async function writeLiveRun(
  deps: ConfigStoreDeps,
  input: LiveRunPointerInput,
): Promise<void> {
  await writeLiveRunPointer(
    deps.kv,
    envScope(input.appId, input.environmentId),
    input.experimentId,
    input.runId,
  );
}

export async function clearLiveRun(
  deps: ConfigStoreDeps,
  input: Omit<LiveRunPointerInput, "runId">,
): Promise<void> {
  await clearLiveRunPointer(
    deps.kv,
    envScope(input.appId, input.environmentId),
    input.experimentId,
  );
}
