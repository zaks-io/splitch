/** The one refusal shape every authentication door on this Worker emits. */
export function unauthorized(): Response {
  return Response.json(
    { code: "UNAUTHORIZED", message: "authentication required", details: {} },
    { status: 401 },
  );
}
