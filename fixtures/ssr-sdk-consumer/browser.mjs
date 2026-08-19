import { createSplitchBrowserClient } from "@splitch/sdk/browser";

function requiredElement(documentRoot, id) {
  const element = documentRoot.getElementById(id);
  if (element === null) {
    throw new Error(`SSR page is missing #${id}`);
  }
  return element;
}

function readJson(documentRoot, id) {
  const text = requiredElement(documentRoot, id).textContent;
  if (typeof text !== "string" || text.length === 0) {
    throw new Error(`SSR page has an empty #${id} payload`);
  }
  return JSON.parse(text);
}

export async function hydratePage(documentRoot = globalThis.document, testHooks = {}) {
  const bootstrap = readJson(documentRoot, "splitch-bootstrap");
  const config = readJson(documentRoot, "splitch-config");
  const output = requiredElement(documentRoot, "flag-value");
  const serverValueJson = output.textContent;
  if (typeof serverValueJson !== "string") {
    throw new Error("SSR page has no rendered Flag value");
  }

  const splitch = createSplitchBrowserClient({
    clientKey: config.clientKey,
    context: config.context,
    bootstrap,
    endpoint: config.endpoint,
    revalidateMs: 60_000,
    ...(testHooks.fetch === undefined ? {} : { fetch: testHooks.fetch }),
  });
  await splitch.init();
  await testHooks.beforeFirstRead?.();

  const hydratedValueJson = JSON.stringify(splitch.evaluate(config.flagKey, false));
  output.textContent = hydratedValueJson;
  await testHooks.afterFirstRead?.();

  const exposureResults = await splitch.flush();
  if (testHooks.closeAfterProof === true) {
    await splitch.close();
  }
  return { exposureResults, hydratedValueJson, serverValueJson };
}

if (typeof document !== "undefined") {
  hydratePage().then(
    (proof) => {
      globalThis.__SPLITCH_SSR_PROOF__ = proof;
    },
    (error) => {
      globalThis.__SPLITCH_SSR_PROOF__ = {
        errorCode: typeof error === "object" && error !== null ? error.code : undefined,
      };
    },
  );
}
