import type { ResourceDeleteBlocker } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { deleteConsequences } from "./app-delete-consequences";

/**
 * The dry run is what the danger zone confirms against, so this list is the
 * operator's only chance to notice the App holds something they did not expect.
 * Nothing here may be abridged.
 */
function blocker(overrides: Partial<ResourceDeleteBlocker>): ResourceDeleteBlocker {
  return {
    resourceType: "app",
    resourceId: "app_checkout",
    childType: "flags",
    children: [{ id: "flag_1", removeCommand: "splitch flags delete flag_1" }],
    ...overrides,
  } as ResourceDeleteBlocker;
}

describe("deleteConsequences", () => {
  it("says nothing about an App that holds nothing", () => {
    expect(deleteConsequences([])).toEqual([]);
  });

  it("names one line per child type, in the operator's vocabulary", () => {
    const consequences = deleteConsequences([
      blocker({ childType: "flags" }),
      blocker({
        childType: "flag-config",
        children: [
          { id: "cfg_1", removeCommand: "a" },
          { id: "cfg_2", removeCommand: "b" },
        ],
      }),
    ]);

    expect(consequences).toEqual([
      { childType: "flags", label: "Flag", count: 1, ids: ["flag_1"] },
      {
        childType: "flag-config",
        label: "Flag Configurations",
        count: 2,
        ids: ["cfg_1", "cfg_2"],
      },
    ]);
  });

  it("merges the same child type reported under several parents", () => {
    const consequences = deleteConsequences([
      blocker({
        resourceId: "env_dev",
        resourceType: "environment",
        childType: "experiments",
        children: [{ id: "exp_dev", removeCommand: "a" }],
      }),
      blocker({
        resourceId: "env_prod",
        resourceType: "environment",
        childType: "experiments",
        children: [{ id: "exp_prod", removeCommand: "b" }],
      }),
    ]);

    expect(consequences).toEqual([
      { childType: "experiments", label: "Experiments", count: 2, ids: ["exp_dev", "exp_prod"] },
    ]);
  });

  it("counts a resource once when two parents both report it", () => {
    const consequences = deleteConsequences([
      blocker({
        resourceId: "env_dev",
        childType: "segments",
        children: [{ id: "seg_shared", removeCommand: "a" }],
      }),
      blocker({
        resourceId: "env_prod",
        childType: "segments",
        children: [{ id: "seg_shared", removeCommand: "b" }],
      }),
    ]);

    expect(consequences).toEqual([
      { childType: "segments", label: "Segment", count: 1, ids: ["seg_shared"] },
    ]);
  });

  it("carries every id in full, however many there are", () => {
    const ids = Array.from({ length: 120 }, (_, index) => `flag_${index}`);
    const [consequence] = deleteConsequences([
      blocker({ children: ids.map((id) => ({ id, removeCommand: `rm ${id}` })) }),
    ]);

    expect(consequence?.count).toBe(120);
    expect(consequence?.ids).toEqual(ids);
    expect(consequence?.ids.at(-1)).toBe("flag_119");
  });
});
