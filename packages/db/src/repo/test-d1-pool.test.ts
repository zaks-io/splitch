import { describe, expect, it } from "vitest";
import { createLocalD1 } from "./test-d1-pool";

describe("pooled local D1", () => {
  it("reuses one binding while clearing data between leases", async () => {
    const first = await createLocalD1();
    try {
      await first.d1
        .prepare(
          "INSERT INTO organizations (id, name, slug, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("org_pool_probe", "Pool probe", "pool-probe", "free", "2026-08-05", "2026-08-05")
        .run();
    } finally {
      await first.dispose();
    }

    const second = await createLocalD1();
    try {
      expect(second.d1).toBe(first.d1);
      await expect(
        second.d1
          .prepare("SELECT id FROM organizations WHERE id = ?")
          .bind("org_pool_probe")
          .first(),
      ).resolves.toBeNull();
    } finally {
      await second.dispose();
    }
  });

  it("refuses overlapping leases", async () => {
    const local = await createLocalD1();
    try {
      await expect(createLocalD1()).rejects.toThrow("D1 is already leased");
    } finally {
      await local.dispose();
    }
  });
});
