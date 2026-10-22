export interface WorkerHealthOptions<E> {
  readonly paths: readonly string[];
  readonly respond: (env: E) => Response | Promise<Response>;
}

export async function workerHealthResponse<E>(
  request: Request,
  env: E,
  health: WorkerHealthOptions<E> | undefined,
): Promise<Response | null> {
  if (!health || (request.method !== "GET" && request.method !== "HEAD")) return null;
  if (!health.paths.includes(new URL(request.url).pathname)) return null;
  const response = await health.respond(env);
  return request.method === "HEAD" ? new Response(null, response) : response;
}
