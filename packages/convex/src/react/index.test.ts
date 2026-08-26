import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { makeFunctionReference } from "convex/server";
import { useQuery } from "convex/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalResolutionDetails as ResolutionDetails } from "@splitch/sdk/local-evaluation";
import { createSplitchReact, type SplitchReactQueryArgs } from "./index";

vi.mock("convex/react", () => ({ useQuery: vi.fn() }));

const query = makeFunctionReference<"query", SplitchReactQueryArgs, ResolutionDetails>(
  "splitch:reactFlag",
);
const { useFlag, useFlagDetails } = createSplitchReact(query);

describe("Convex React bindings", () => {
  beforeEach(() => {
    vi.mocked(useQuery).mockReset();
  });

  it("preserves Convex loading semantics", () => {
    vi.mocked(useQuery).mockReturnValue(undefined);

    function Consumer() {
      const value = useFlag("checkout", false);
      return createElement("span", null, value === undefined ? "loading" : String(value));
    }

    expect(renderToString(createElement(Consumer))).toBe("<span>loading</span>");
    expect(useQuery).toHaveBeenCalledWith(query, { flagKey: "checkout", defaultValue: false });
  });

  it("returns the reactive Variant and full Resolution Details", () => {
    const details = {
      value: true,
      variantName: "treatment",
      reason: "SPLIT",
    } as const satisfies ResolutionDetails;
    vi.mocked(useQuery).mockReturnValue(details);

    function Consumer() {
      const value = useFlag("checkout", false);
      const resolution = useFlagDetails("checkout", false);
      return createElement("span", null, `${String(value)}:${resolution?.reason}`);
    }

    expect(renderToString(createElement(Consumer))).toBe("<span>true:SPLIT</span>");
  });
});
