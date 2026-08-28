import { describe, expect, it } from "vitest";
import {
  classFetchIsWrapped,
  defaultExportIsWrapped,
  proveDefaultExportWrapped,
  WRAP_WORKER_HANDLER as WRAPPER,
} from "./hosted-worker-wrap-gate";

const RAW_HANDLER = `{
  fetch() {
    return new Response("raw");
  },
}`;

function wrappedThen(statement: string, exportExpression = "wrapped"): string {
  return `
    import { ${WRAPPER} } from "@splitch/worker-runtime";
    const raw = ${RAW_HANDLER};
    let wrapped = ${WRAPPER}({
      fetch() {
        return new Response("wrapped");
      },
    });
    ${statement}
    export default ${exportExpression};
  `;
}

describe("hosted Worker wrap-gate immutable proof", () => {
  it.each([
    ["fetch assignment", "wrapped.fetch = raw.fetch;"],
    ["computed fetch assignment", 'wrapped["fetch"] = raw.fetch;'],
    ["binding reassignment", "wrapped = raw;"],
    ["binding update", "wrapped++;"],
    ["property update", "wrapped.fetch++;"],
    ["property deletion", "delete wrapped.fetch;"],
    ["Object.assign", "Object.assign(wrapped, raw);"],
    ["Object.defineProperty", 'Object.defineProperty(wrapped, "fetch", { value: raw.fetch });'],
    ["unknown mutating call", "mutate(wrapped);"],
  ])("fails after %s", (_name, statement) => {
    const source = wrappedThen(statement);
    expect(defaultExportIsWrapped(source)).toBe(false);
    expect(proveDefaultExportWrapped(source, "mutated-worker.ts")).toMatchObject({
      wrapped: false,
    });
  });

  it("fails when an alias mutates a wrapped handler fetch", () => {
    const source = wrappedThen("const alias = wrapped; alias.fetch = raw.fetch;");
    expect(defaultExportIsWrapped(source)).toBe(false);
  });

  it.each([
    ["conditional", "const alias = true ? wrapped : wrapped; alias.fetch = raw.fetch;"],
    ["comma", "const alias = (0, wrapped); alias.fetch = raw.fetch;"],
  ])("fails when a %s alias mutates a wrapped handler fetch", (_name, statement) => {
    expect(defaultExportIsWrapped(wrappedThen(statement))).toBe(false);
  });

  it("fails when a helper-returned wrapped handler is mutated", () => {
    const source = wrappedThen(`
      function getWrapped() {
        return wrapped;
      }
      getWrapped().fetch = raw.fetch;
    `);
    expect(defaultExportIsWrapped(source)).toBe(false);
  });

  it("fails when an arrow-returned wrapped handler is passed to Object.defineProperty", () => {
    const source = wrappedThen(`
      const getWrapped = () => wrapped;
      Object.defineProperty(getWrapped(), "fetch", { value: raw.fetch });
    `);
    expect(defaultExportIsWrapped(source)).toBe(false);
  });

  it("fails when an omitted parameter default returns a wrapped handler for mutation", () => {
    const source = wrappedThen(`
      function choose(handler = wrapped) {
        return handler;
      }
      choose().fetch = raw.fetch;
    `);
    expect(defaultExportIsWrapped(source)).toBe(false);
  });

  it("fails when a class field carries a wrapped handler for mutation", () => {
    const source = wrappedThen(`
      class Holder {
        value = wrapped;
      }
      const holder = new Holder();
      holder.value.fetch = raw.fetch;
    `);
    expect(defaultExportIsWrapped(source)).toBe(false);
  });

  it("fails when a generator yields a wrapped handler for mutation", () => {
    const source = wrappedThen(`
      function* values() {
        yield wrapped;
      }
      values().next().value.fetch = raw.fetch;
    `);
    expect(defaultExportIsWrapped(source)).toBe(false);
  });

  it.each([
    ["conditional assignment", "(true ? wrapped : wrapped).fetch = raw.fetch;"],
    ["comma assignment", "(0, wrapped).fetch = raw.fetch;"],
    ["type-asserted update", "(wrapped as any).fetch++;"],
    ["conditional delete", "delete (true ? wrapped : wrapped).fetch;"],
    ["conditional unknown call", "(true ? wrapped : wrapped).mutate();"],
  ])("fails after transparent receiver %s", (_name, statement) => {
    expect(defaultExportIsWrapped(wrappedThen(statement))).toBe(false);
  });

  it("fails when a constructor default carries a wrapped handler", () => {
    const source = wrappedThen(`
      class Holder {
        value: typeof wrapped;
        constructor(handler = wrapped) {
          this.value = handler;
        }
      }
      new Holder().value.fetch = raw.fetch;
    `);
    expect(defaultExportIsWrapped(source)).toBe(false);
  });

  it("fails when a destructuring default carries a wrapped handler", () => {
    const source = wrappedThen(`
      const { value = wrapped } = {};
      value.fetch = raw.fetch;
    `);
    expect(defaultExportIsWrapped(source)).toBe(false);
  });

  it("fails when a thrown wrapped handler is mutated through catch", () => {
    const source = wrappedThen(`
      try {
        throw wrapped;
      } catch (caught) {
        caught.fetch = raw.fetch;
      }
    `);
    expect(defaultExportIsWrapped(source)).toBe(false);
  });

  it.each([
    ["object property", "const holder = { value: wrapped }; holder.value.fetch = raw.fetch;"],
    ["array element", "const holder = [wrapped]; holder[0].fetch = raw.fetch;"],
  ])("fails when %s storage hides a wrapped handler mutation", (_name, statement) => {
    expect(defaultExportIsWrapped(wrappedThen(statement))).toBe(false);
  });

  it("fails when a wrapped handler escapes through a constructor", () => {
    const source = wrappedThen(`
      class Mutator {
        constructor(handler: typeof wrapped) {
          handler.fetch = raw.fetch;
        }
      }
      new Mutator(wrapped);
    `);
    expect(defaultExportIsWrapped(source)).toBe(false);
  });

  it("fails an exported class after its delegated wrapped fetch is replaced", () => {
    const source = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      const raw = ${RAW_HANDLER};
      const wrapped = ${WRAPPER}(raw);
      wrapped.fetch = raw.fetch;
      export default ${WRAPPER}(raw);
      export class MutatedDoor extends WorkerEntrypoint {
        fetch(request: Request) {
          return wrapped.fetch(request, this.env, this.ctx);
        }
      }
    `;
    expect(classFetchIsWrapped(source, "MutatedDoor")).toBe(false);
  });

  it("rejects parameter-default wrapper factories for supplied and omitted arguments", () => {
    const suppliedUnwrapped = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      const raw = ${RAW_HANDLER};
      function choose(handler = ${WRAPPER}(raw)) {
        return handler;
      }
      export default choose(raw);
    `;
    const omittedUsesDefault = suppliedUnwrapped.replace("choose(raw)", "choose()");

    expect(defaultExportIsWrapped(suppliedUnwrapped)).toBe(false);
    expect(defaultExportIsWrapped(omittedUsesDefault)).toBe(false);
  });

  it("rejects an explicitly supplied wrapped argument through a helper", () => {
    const source = `
      import { ${WRAPPER} } from "@splitch/worker-runtime";
      function choose(handler: unknown) {
        return handler;
      }
      export default choose(${WRAPPER}(${RAW_HANDLER}));
    `;
    expect(defaultExportIsWrapped(source)).toBe(false);
  });
});
