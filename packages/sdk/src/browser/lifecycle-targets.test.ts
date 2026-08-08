import { describe, expect, it } from "vitest";
import { resolveDocument, resolveWindow } from "./lifecycle-targets";

describe("lifecycle-targets absent semantics", () => {
  it("explicit document: null does not fall through to ambient document", () => {
    const ambient = {
      addEventListener() {
        /* noop */
      },
    } as unknown as Document;
    const previous = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      value: ambient,
      configurable: true,
      writable: true,
    });
    try {
      expect(resolveDocument({ document: null })).toBeNull();
      expect(resolveDocument({})).toBe(ambient);
    } finally {
      Object.defineProperty(globalThis, "document", {
        value: previous,
        configurable: true,
        writable: true,
      });
    }
  });

  it("explicit window: null does not fall through to ambient window", () => {
    const ambient = {
      addEventListener() {
        /* noop */
      },
    } as unknown as Window;
    const previous = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      value: ambient,
      configurable: true,
      writable: true,
    });
    try {
      expect(resolveWindow({ window: null })).toBeNull();
      expect(resolveWindow({})).toBe(ambient);
    } finally {
      Object.defineProperty(globalThis, "window", {
        value: previous,
        configurable: true,
        writable: true,
      });
    }
  });
});
