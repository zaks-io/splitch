import type { Env } from "./types";

export interface WriterRequest {
  readonly method: string;
  readonly name: string;
  readonly path: string;
}

/**
 * The Assignment Store instance, seeded independently of `ASSIGNMENTS_KV` so a
 * test can reproduce the real ordering: the instance commits first and the KV
 * mirror trails it. The route table matches
 * `AssignmentStoreDurableObjectV2.fetch`, which 404s anything but `GET
 * /export`, so a caller that mistypes the route fails here instead of in
 * production.
 */
export function assignmentWriterStub(
  values: Map<string, string>,
  requests: WriterRequest[],
): NonNullable<Env["ASSIGNMENT_STORE_WRITER"]> {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        requests.push({ method: request.method, name: String(id), path });
        if (request.method !== "GET" || path !== "/export") {
          return Response.json({ error: "not found" }, { status: 404 });
        }
        return Response.json({
          assignments: JSON.parse(values.get(String(id)) ?? "{}"),
          tombstoned: false,
          proof: "assignment-do-winners-exported-v1",
        });
      },
    }),
  };
}
