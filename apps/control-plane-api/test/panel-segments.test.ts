import { env } from "cloudflare:workers";
import type { Condition } from "@splitch/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import worker, { type SignedControlPanelEntrypoint } from "../src/index.js";
import {
  panelEntrypoint,
  panelFlagsIds,
  panelTestEnv,
  seedAppMembership,
  seedPanelFlags,
  signedPanelRequest,
  testCtx,
} from "./panel-flags-harness.js";

const ids = panelFlagsIds("segments");
const { appId: APP_ID, envId: ENV_ID, otherEnvId: OTHER_ENV_ID, userId: USER_ID } = ids;
let testEnv: ControlPlaneApiEnv;
let entrypoint: SignedControlPanelEntrypoint;

beforeAll(async () => {
  await seedPanelFlags(ids);
  testEnv = panelTestEnv();
  entrypoint = panelEntrypoint(testEnv);
});

describe("SignedControlPanelEntrypoint Segment operations", () => {
  it("round-trips CRUD for Segments with Conditions", async () => {
    const paid = await createSegment({
      name: "Paid plan",
      conditions: [{ attribute: "plan", operator: "eq", value: "paid" }],
    });
    const enterprise = await createSegment({
      name: "Enterprise markets",
      description: "Paid plan in US or CA",
      conditions: [
        { attribute: "plan", operator: "eq", value: "enterprise" },
        { attribute: "country", operator: "in", value: ["US", "CA"] },
      ],
    });
    const created = [paid, enterprise];

    const list = await panelRequest("GET", `/apps/${APP_ID}/segments`);
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as { items: Array<{ id: string; name: string }> }).items
        .filter((segment) => created.some(({ id }) => id === segment.id))
        .map(({ name }) => name)
        .sort(),
    ).toEqual(["Enterprise markets", "Paid plan"]);

    for (const segment of created) {
      const updated = await panelRequest("PATCH", `/apps/${APP_ID}/segments/${segment.id}`, {
        name: `${segment.name} edited`,
      });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({
        id: segment.id,
        name: `${segment.name} edited`,
      });

      const read = await panelRequest("GET", `/apps/${APP_ID}/segments/${segment.id}`);
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({
        id: segment.id,
        name: `${segment.name} edited`,
      });
    }

    for (const segment of created) {
      const deleted = await panelRequest("DELETE", `/apps/${APP_ID}/segments/${segment.id}`);
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ deleted: true });
    }
  });

  it("rechecks live Organization/App membership and Environment ownership", async () => {
    await env.DB.prepare("DELETE FROM app_memberships WHERE app_id = ? AND user_id = ?")
      .bind(APP_ID, USER_ID)
      .run();
    expect((await panelRequest("GET", `/apps/${APP_ID}/segments`)).status).toBe(403);
    await seedAppMembership(ids);

    await env.DB.prepare("DELETE FROM org_memberships WHERE org_id = ? AND user_id = ?")
      .bind(ids.orgId, USER_ID)
      .run();
    expect((await panelRequest("GET", `/apps/${APP_ID}/segments`)).status).toBe(403);
    await env.DB.prepare(
      "INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)",
    )
      .bind(ids.orgId, USER_ID, "owner", "2026-07-19T00:00:00.000Z")
      .run();

    const crossAppIds = { ...ids, envId: OTHER_ENV_ID };
    const crossApp = await entrypoint.fetch(
      await signedPanelRequest(crossAppIds, "GET", `/apps/${APP_ID}/segments`),
    );
    expect(crossApp.status).toBe(403);
    expect(await crossApp.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps Segment delegations off public HTTP and binds them to the exact resource", async () => {
    const createBody = {
      name: "Resource bound",
      conditions: [{ attribute: "plan", operator: "eq", value: "bound" }],
    };
    const request = await signedPanelRequest(ids, "POST", `/apps/${APP_ID}/segments`, createBody);
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("x-splitch-panel-session")).toBeNull();

    const publicResponse = await worker.fetch(request.clone(), testEnv, testCtx);
    expect(publicResponse.status).toBe(401);

    const created = await entrypoint.fetch(request);
    expect(created.status).toBe(200);
    const segment = (await created.json()) as { id: string };
    const wrongResource = await signedPanelRequest(
      ids,
      "GET",
      `/apps/${APP_ID}/segments/${segment.id}`,
      undefined,
      {
        id: "segments_get",
        appId: APP_ID,
        environmentId: ENV_ID,
        segmentId: "segment_other",
      },
    );
    expect((await entrypoint.fetch(wrongResource)).status).toBe(401);
  });
});

type SegmentCreateBody = {
  name: string;
  description?: string;
  conditions: Condition[];
};

async function createSegment(body: SegmentCreateBody) {
  const response = await panelRequest("POST", `/apps/${APP_ID}/segments`, body);
  if (!response.ok) throw new Error(`Segment create failed: ${await response.text()}`);
  return (await response.json()) as {
    id: string;
    name: string;
  };
}

function panelRequest(method: string, path: string, body?: unknown): Promise<Response> {
  return signedPanelRequest(ids, method, path, body).then((request) => entrypoint.fetch(request));
}
