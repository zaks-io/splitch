import { describe, expect, it, vi } from "vitest";
import type { ApprovalArchiveEvent } from "../src/approval-archive";
import { approvalArchiveStoreFromEnv } from "../src/approval-archive-tinybird";
import type { ControlPlaneApiEnv } from "../src/env";

const EVENT: ApprovalArchiveEvent = {
  audit_id: "audit_archive_1",
  dedup_key: "apr_archive_1:1",
  app_id: "app_archive_1",
  user_id: "user_archive_1",
  auth_method: "device_flow",
  action: "approval_request.archive",
  resource_type: "approval_request",
  resource_id: "apr_archive_1",
  changes: '{"archiveVersion":1}',
  timestamp: "2026-08-07T12:00:00.000Z",
  archive_version: 1,
  archived_d1_row_count: 3,
  archive_checksum: `sha256:${"a".repeat(64)}`,
  request_status: "declined",
  target_type: "flag_configuration",
  proposed_at: "2026-04-01T00:00:00.000Z",
  resolved_at: "2026-05-01T00:00:00.000Z",
  policy_contexts: "[]",
};

const ENV = {
  TINYBIRD_API_URL: "https://api.tinybird.test",
  TINYBIRD_APPROVAL_ARCHIVE_WRITE_TOKEN: "write-token",
  TINYBIRD_APPROVAL_ARCHIVE_READ_TOKEN: "read-token",
} as ControlPlaneApiEnv;

describe("Tinybird Approval Request archive append", () => {
  it("waits for and validates the committed one-row acknowledgment", async () => {
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ successful_rows: 1, quarantined_rows: 0 })),
    );
    const store = approvalArchiveStoreFromEnv(ENV, fetchFn);

    await expect(store.append(EVENT)).resolves.toBeUndefined();

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.tinybird.test/v0/events?name=audit_log&wait=true");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer write-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(EVENT),
    });
  });

  it.each([
    {
      name: "asynchronous acceptance",
      response: () => Response.json({ successful_rows: 1, quarantined_rows: 0 }, { status: 202 }),
      message: "HTTP 202",
    },
    {
      name: "non-JSON acknowledgment",
      response: () => new Response("accepted", { status: 200 }),
      message: "acknowledgment is malformed",
    },
    {
      name: "row-count mismatch",
      response: () => Response.json({ successful_rows: 0, quarantined_rows: 0 }),
      message: "append mismatch",
    },
    {
      name: "quarantined row",
      response: () => Response.json({ successful_rows: 1, quarantined_rows: 1 }),
      message: "append mismatch",
    },
  ])("fails loud on $name", async ({ response, message }) => {
    const store = approvalArchiveStoreFromEnv(ENV, () => Promise.resolve(response()));

    await expect(store.append(EVENT)).rejects.toThrow(message);
  });
});

describe("Tinybird Approval Request archive reads", () => {
  it("uses the scoped read token", async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ data: [] })));
    const store = approvalArchiveStoreFromEnv(ENV, fetchFn);

    await expect(store.list({ appId: "app_archive_1", limit: 10 })).resolves.toEqual([]);

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://api.tinybird.test/v0/pipes/approval_request_archives.json?app_id=app_archive_1&limit=10",
    );
    expect(init).toMatchObject({
      headers: { authorization: "Bearer read-token" },
    });
  });

  it("fails loud on a 403 instead of returning an empty page", async () => {
    const store = approvalArchiveStoreFromEnv(ENV, () =>
      Promise.resolve(Response.json({ data: [] }, { status: 403 })),
    );

    await expect(store.list({ appId: "app_archive_1", limit: 10 })).rejects.toThrow("HTTP 403");
  });
});

describe("Tinybird Approval Request archive token requirements", () => {
  it.each([
    {
      name: "write token",
      env: { ...ENV, TINYBIRD_APPROVAL_ARCHIVE_WRITE_TOKEN: undefined },
      invoke: (store: ReturnType<typeof approvalArchiveStoreFromEnv>) => store.append(EVENT),
      message: "write token is unavailable",
    },
    {
      name: "read token",
      env: { ...ENV, TINYBIRD_APPROVAL_ARCHIVE_READ_TOKEN: undefined },
      invoke: (store: ReturnType<typeof approvalArchiveStoreFromEnv>) =>
        store.list({ appId: "app_archive_1", limit: 10 }),
      message: "read token is unavailable",
    },
  ])("rejects an absent $name before fetch", async ({ env, invoke, message }) => {
    const fetchFn = vi.fn<typeof fetch>();
    const store = approvalArchiveStoreFromEnv(env, fetchFn);

    await expect(invoke(store)).rejects.toThrow(message);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
