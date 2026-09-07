export function durableState(): {
  ctx: DurableObjectState;
  alarmTime(): number | null;
  lastReadKeys(): readonly string[];
  stored(): { publicationAttempts?: number } | undefined;
} {
  const storage = new Map<string, unknown>();
  let alarmTime: number | null = null;
  let lastReadKeys: readonly string[] = [];
  const ctx = {
    storage: {
      async get<T>(key: string | string[]) {
        lastReadKeys = typeof key === "string" ? [key] : [...key];
        if (Array.isArray(key)) {
          return new Map(
            key.flatMap((item) =>
              storage.has(item) ? [[item, structuredClone(storage.get(item))] as const] : [],
            ),
          );
        }
        return storage.has(key) ? (structuredClone(storage.get(key)) as T) : undefined;
      },
      async put(key: string, value: unknown) {
        storage.set(key, structuredClone(value));
      },
      async delete(key: string | string[]) {
        if (Array.isArray(key)) {
          return key.reduce((count, item) => count + Number(storage.delete(item)), 0);
        }
        return storage.delete(key);
      },
      async setAlarm(time: number | Date) {
        alarmTime = typeof time === "number" ? time : time.getTime();
      },
    },
  } as unknown as DurableObjectState;
  return {
    ctx,
    alarmTime: () => alarmTime,
    lastReadKeys: () => lastReadKeys,
    stored: () =>
      storage.get("evaluation-commit-outbox") as { publicationAttempts?: number } | undefined,
  };
}
