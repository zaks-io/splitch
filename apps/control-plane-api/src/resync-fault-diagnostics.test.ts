import { inspect } from "node:util";
import type { Repository } from "@splitch/db";
import { expect, it, vi } from "vitest";
import type { ConfigStoreAccess } from "./config-store-access";
import { resyncFlagSnapshots } from "./flag-definition-handler-utils";

it("withholds native JSON parse causes during per-Environment resync and continues", async () => {
  const canary = "qxZ7s3crt";
  let failure: unknown;
  try {
    JSON.parse(`${canary}!`);
  } catch (error) {
    failure = error;
  }
  expect((failure as Error).message).toContain(canary);
  const warn = vi.fn();
  const resync = vi
    .fn()
    .mockRejectedValueOnce(new Error("resync failed", { cause: failure }))
    .mockResolvedValue({ ok: true });
  await resyncFlagSnapshots(
    {
      repo: {
        identity: {
          listEnvironments: async () => [
            { id: "env_1", expiresAt: null },
            { id: "env_2", expiresAt: null },
          ],
        },
      } as unknown as Repository,
      configStore: {
        writerFor: () => ({ resyncFlagConfig: resync }),
      } as unknown as ConfigStoreAccess,
      logger: { warn },
    },
    "app_1",
    "flag_1",
  );

  expect(resync).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledWith(
    "variant_catalog_kv_resync_failed",
    expect.objectContaining({ environmentId: "env_1" }),
  );
  const logged = inspect(warn.mock.calls, {
    showHidden: true,
    depth: null,
    maxStringLength: null,
    maxArrayLength: null,
  });
  expect(logged).not.toContain(canary);
  expect(logged).toContain("[message withheld]");
});
