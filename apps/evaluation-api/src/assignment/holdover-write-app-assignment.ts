import { keyVersionOf } from "@splitch/privacy";
import { assignmentWriterName } from "./assignment-store";
import { parseHashedAssignmentPut } from "./assignment-store-input";
import {
  admitAppInventoryAssignment,
  type HoldoverWriteAppInventoryStorage,
} from "./holdover-write-app-inventory";
import type { AssignmentWriterNamespace } from "./kv-assignment-store";

export interface HoldoverWriteAppAssignmentEnv {
  ASSIGNMENT_STORE_WRITER?: AssignmentWriterNamespace;
}

export async function putHoldoverWriteAppAssignment(
  storage: HoldoverWriteAppInventoryStorage,
  env: HoldoverWriteAppAssignmentEnv,
  appId: string,
  request: Request,
): Promise<Response> {
  const input = parseHashedAssignmentPut(await request.json());
  if (input.appId !== appId) {
    return Response.json({ error: "Assignment App scope mismatch" }, { status: 400 });
  }
  if (keyVersionOf(input.targetingKeyHash) !== input.identityVersion) {
    return Response.json({ error: "Assignment identity generation mismatch" }, { status: 409 });
  }
  const admission = await admitAppInventoryAssignment(
    storage,
    { idType: input.idType, targetingKeyHash: input.targetingKeyHash },
    input.identityVersion,
  );
  if (admission.status !== "registered") {
    return Response.json(
      { error: "App identity generation changed during Assignment" },
      { status: 409 },
    );
  }
  const writers = env.ASSIGNMENT_STORE_WRITER;
  if (!writers) throw new Error("ASSIGNMENT_STORE_WRITER is required for Assignment mutation");
  const response = await writers
    .get(writers.idFromName(assignmentWriterName(input)))
    .fetch("https://assignment-store.local/put", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  if (!response.ok) throw new Error(`Assignment writer DO returned ${String(response.status)}`);
  return Response.json(await response.json());
}
