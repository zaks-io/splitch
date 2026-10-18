export interface ConfigStoreProjectionJournal {
  record(key: string): Promise<void>;
  list(): Promise<readonly string[]>;
}

const PROJECTION_KEY_PREFIX = "projection-key:";
const JOURNAL_PAGE_SIZE = 128;

export function makeDurableConfigStoreProjectionJournal(
  storage: Pick<DurableObjectStorage, "put" | "list">,
): ConfigStoreProjectionJournal {
  return {
    async record(key) {
      await storage.put(`${PROJECTION_KEY_PREFIX}${key}`, true);
    },
    async list() {
      const keys: string[] = [];
      let startAfter: string | undefined;
      for (;;) {
        const page = await storage.list<unknown>({
          prefix: PROJECTION_KEY_PREFIX,
          limit: JOURNAL_PAGE_SIZE,
          ...(startAfter === undefined ? {} : { startAfter }),
        });
        keys.push(...[...page].map(projectionKeyFromEntry));
        if (page.size < JOURNAL_PAGE_SIZE) return keys;
        startAfter = [...page.keys()].at(-1);
      }
    },
  };
}

function projectionKeyFromEntry([key, value]: [string, unknown]): string {
  if (value !== true) throw new Error("config-store: invalid projection journal entry");
  return key.slice(PROJECTION_KEY_PREFIX.length);
}

/** Journal entries survive deletes and failed puts until Environment state is cleared. */
export function journaledConfigStoreKv(
  kv: KVNamespace,
  journal: ConfigStoreProjectionJournal,
): KVNamespace {
  return new Proxy(kv, {
    get(target, property) {
      if (property === "put") {
        return async (...args: Parameters<KVNamespace["put"]>) => {
          await journal.record(args[0]);
          return target.put(...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
