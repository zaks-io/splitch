import type { PersonalAccessTokenGrant } from "@splitch/sdk/control-plane";
import open from "open";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_OK } from "./exit-codes.js";
import {
  BROAD,
  personalAccessTokenMutations as mutations,
  runPersonalAccessTokenStepUp as run,
  TOKEN,
} from "./personal-access-token-test-fixtures.js";
import { cleanupTempHomes } from "./test-helpers.js";

vi.mock("open", () => ({ default: vi.fn() }));
beforeEach(() => {
  vi.mocked(open).mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

const losses = [
  "Org demoted",
  "App demoted",
  "both demoted",
  "Org removed",
  "App removed",
  "both removed",
] as const;
const changes = ["retained", "permissions narrowed", "role narrowed", "dropped"] as const;
const helper: PersonalAccessTokenGrant = {
  target: "app:app_helper",
  role: "owner",
  permissions: ["write", "delete"],
};

function grantArgument(grant: PersonalAccessTokenGrant): string {
  return `${grant.target}:${grant.role}:${grant.permissions.join(",") || "read"}`;
}

describe("CLI cleanup after losing membership", () => {
  it.each(
    losses.flatMap((loss) =>
      (["Org", "App"] as const).flatMap((target) =>
        changes.map((change) => ({ loss, target, change })),
      ),
    ),
  )(
    "keeps $target $change with $loss free of approval and App reads",
    async ({ loss, target, change }) => {
      const stored: PersonalAccessTokenGrant = {
        target: target === "Org" ? "org:org_lost" : "app:app_lost",
        role: "owner",
        permissions: ["write", "delete"],
      };
      const outcomes: Record<(typeof changes)[number], PersonalAccessTokenGrant[]> = {
        dropped: [helper],
        retained: [stored, { ...helper, permissions: [] }],
        "permissions narrowed": [{ ...stored, permissions: ["write"] }, helper],
        "role narrowed": [{ ...stored, role: "member" }, helper],
      };
      const grants = outcomes[change];
      const { result, requests } = await run(
        ["update", TOKEN.id, ...grants.flatMap((grant) => ["--grant", grantArgument(grant)])],
        {
          current: { ...BROAD, grants: [stored, helper] },
          scopes: ["app:app_other:member"],
          appFailures: loss.endsWith("removed") ? { app_lost: 403 } : {},
        },
      );
      expect(result.exitCode).toBe(EXIT_OK);
      expect(open).not.toHaveBeenCalled();
      expect(requests.some((request) => request.url.includes("/apps/"))).toBe(false);
      expect(mutations(requests)).toHaveLength(1);
      expect(mutations(requests)[0]?.headers.has("Splitch-PAT-Authorization")).toBe(false);
    },
  );

  it.each(([403, 404] as const).flatMap((status) => changes.map((change) => ({ status, change }))))(
    "narrows an Org with an unreadable App $change returning $status",
    async ({ status, change }) => {
      const retained: PersonalAccessTokenGrant = {
        target: "app:app_lost",
        role: "owner",
        permissions: ["write", "delete"],
      };
      const outcomes: Record<(typeof changes)[number], PersonalAccessTokenGrant[]> = {
        retained: [retained],
        "permissions narrowed": [{ ...retained, permissions: ["write"] }],
        "role narrowed": [{ ...retained, role: "member" }],
        dropped: [],
      };
      const { result, requests, session } = await run(
        [
          "update",
          TOKEN.id,
          "--grant",
          "app:app_1:member:read",
          ...outcomes[change].flatMap((grant) => ["--grant", grantArgument(grant)]),
        ],
        {
          current: {
            ...BROAD,
            grants: [{ target: "org:org_1", role: "owner", permissions: ["write"] }, retained],
          },
          scopes: ["app:app_other:member"],
          appFailures: { app_lost: status },
          catalogReadRebind: true,
        },
      );
      expect(result.exitCode).toBe(EXIT_OK);
      expect(open).not.toHaveBeenCalled();
      expect(
        requests
          .filter((request) => request.url.includes("/apps/"))
          .map((request) => new URL(request.url).pathname),
      ).toEqual(["/apps/app_1"]);
      expect(mutations(requests)).toHaveLength(1);
      expect(mutations(requests)[0]?.headers.get("authorization")).toBe(
        `Bearer ${session.credential.accessToken}`,
      );
      expect(mutations(requests)[0]?.headers.has("Splitch-PAT-Authorization")).toBe(false);
    },
  );

  it.each([403, 404, "transport"] as const)(
    "sends cleanup without approval when Org-to-App discovery returns %s",
    async (status) => {
      const { result, requests, session } = await run(
        ["update", TOKEN.id, "--grant", "app:app_1:member:read"],
        {
          current: {
            ...BROAD,
            grants: [{ target: "org:org_1", role: "owner", permissions: ["write"] }],
          },
          scopes: ["app:app_other:member"],
          appFailures: { app_1: status },
          catalogReadRebind: true,
        },
      );
      expect(result.exitCode).toBe(EXIT_OK);
      expect(open).not.toHaveBeenCalled();
      expect(mutations(requests)).toHaveLength(1);
      expect(mutations(requests)[0]?.headers.get("authorization")).toBe(
        `Bearer ${session.credential.accessToken}`,
      );
      expect(mutations(requests)[0]?.headers.has("Splitch-PAT-Authorization")).toBe(false);
    },
  );
});
