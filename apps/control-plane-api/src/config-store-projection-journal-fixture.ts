import type { ConfigStoreProjectionJournal } from "./config-store-projection-journal";

export function makeConfigStoreProjectionJournalFixture(): ConfigStoreProjectionJournal & {
  clear(): void;
} {
  const keys = new Set<string>();
  return {
    async record(key) {
      keys.add(key);
    },
    async list() {
      return [...keys];
    },
    clear() {
      keys.clear();
    },
  };
}
