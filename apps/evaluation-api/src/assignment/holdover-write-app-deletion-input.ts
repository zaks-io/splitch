export async function parseDeletionBody(
  request: Request,
): Promise<
  | { ok: true; appId: string; generationId: string; deleteBeforeTsMs: number }
  | { ok: false; response: Response }
> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: Response.json({ error: "invalid JSON" }, { status: 400 }) };
  }
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { deleteBeforeTsMs?: unknown }).deleteBeforeTsMs !== "number" ||
    !Number.isFinite((body as { deleteBeforeTsMs: number }).deleteBeforeTsMs)
  ) {
    return {
      ok: false,
      response: Response.json({ error: "deleteBeforeTsMs is required" }, { status: 400 }),
    };
  }
  const deleteBeforeTsMs = (body as { deleteBeforeTsMs: number }).deleteBeforeTsMs;
  const appIdFromBody = (body as { appId?: unknown }).appId;
  const appId =
    typeof appIdFromBody === "string" && appIdFromBody.length > 0 ? appIdFromBody : undefined;
  if (appId === undefined) {
    return {
      ok: false,
      response: Response.json(
        { error: "appId is required for App deletion suppress" },
        { status: 400 },
      ),
    };
  }
  const generationId =
    typeof (body as { generationId?: unknown }).generationId === "string"
      ? (body as { generationId: string }).generationId
      : "";
  if (generationId.length === 0) {
    return {
      ok: false,
      response: Response.json({ error: "generationId is required" }, { status: 400 }),
    };
  }
  return { ok: true, appId, generationId, deleteBeforeTsMs };
}

export async function parseAppIdBody(
  request: Request,
  doName: string | undefined,
): Promise<{ ok: true; appId: string; generationId: string } | { ok: false; response: Response }> {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const appIdFromBody =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { appId?: unknown }).appId === "string"
      ? (body as { appId: string }).appId
      : "";
  const appId = appIdFromBody.length > 0 ? appIdFromBody : doName;
  if (typeof appId !== "string" || appId.length === 0) {
    return {
      ok: false,
      response: Response.json(
        { error: "appId is required to cancel App deletion" },
        { status: 400 },
      ),
    };
  }
  const generationId =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { generationId?: unknown }).generationId === "string"
      ? (body as { generationId: string }).generationId
      : "";
  if (generationId.length === 0) {
    return {
      ok: false,
      response: Response.json({ error: "generationId is required" }, { status: 400 }),
    };
  }
  return { ok: true, appId, generationId };
}

export async function parseMarkD1Body(
  request: Request,
): Promise<
  | { ok: true; appId: string; generationId: string; deleteBeforeTsMs: number | undefined }
  | { ok: false; response: Response }
> {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const appIdFromBody = readString(body, "appId");
  if (appIdFromBody.length === 0) {
    return {
      ok: false,
      response: Response.json({ error: "appId is required to mark D1 deletion" }, { status: 400 }),
    };
  }
  const generationId = readString(body, "generationId");
  if (generationId.length === 0) {
    return {
      ok: false,
      response: Response.json({ error: "generationId is required" }, { status: 400 }),
    };
  }
  const raw = readProperty(body, "deleteBeforeTsMs");
  const deleteBeforeTsMs = typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
  return { ok: true, appId: appIdFromBody, generationId, deleteBeforeTsMs };
}

function readString(body: unknown, property: string): string {
  const value = readProperty(body, property);
  return typeof value === "string" ? value : "";
}

function readProperty(body: unknown, property: string): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  return (body as Record<string, unknown>)[property];
}
