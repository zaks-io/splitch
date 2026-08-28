import type { SaltStore } from "@splitch/privacy";
import type { AssignmentKv, AssignmentPutInput, AssignmentStoreLogger } from "./assignment-store";
import type { AssignmentWriterStorage } from "./assignment-store-writer";
import type { AssignmentWriterNamespace } from "./kv-assignment-store";

export const RAW_TARGETING_KEY = "alice@example.com";

export const basePut: AssignmentPutInput = {
  appId: "app-A",
  experimentId: "exp-checkout",
  idType: "user",
  targetingKey: RAW_TARGETING_KEY,
  runId: "run-1",
  variant: "control",
};

export class StaticSaltStore implements SaltStore {
  private readonly salts = new Map([
    ["app-A", bytes("salt-for-app-a")],
    ["app-B", bytes("salt-for-app-b")],
  ]);

  currentKeyVersion(): Promise<string> {
    return Promise.resolve("v1");
  }

  saltFor(appId: string): Promise<Uint8Array<ArrayBuffer>> {
    const salt = this.salts.get(appId);
    if (salt === undefined) {
      throw new Error(`missing salt for ${appId}`);
    }
    return Promise.resolve(salt);
  }

  retainedKeyVersions(): Promise<readonly string[]> {
    return Promise.resolve(["v1"]);
  }
}

export class RecordingKv implements AssignmentKv {
  private readonly store = new Map<string, string>();
  readonly getCalls: string[] = [];
  readonly putCalls: string[] = [];
  readonly deleteCalls: string[] = [];
  failPuts: boolean;
  failDeletes: boolean;
  failPutsRemaining: number;
  failDeletesRemaining: number;

  constructor(
    options: {
      failPuts?: boolean;
      failDeletes?: boolean;
      failPutsRemaining?: number;
      failDeletesRemaining?: number;
    } = {},
  ) {
    this.failPuts = options.failPuts ?? false;
    this.failDeletes = options.failDeletes ?? false;
    this.failPutsRemaining = options.failPutsRemaining ?? 0;
    this.failDeletesRemaining = options.failDeletesRemaining ?? 0;
  }

  putRaw(key: string, value: string): this {
    this.store.set(key, value);
    return this;
  }

  raw(key: string): string | undefined {
    return this.store.get(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  get(key: string): Promise<string | null> {
    this.getCalls.push(key);
    return Promise.resolve(this.store.get(key) ?? null);
  }

  async put(key: string, value: string): Promise<void> {
    this.putCalls.push(key);
    if (this.failPuts || this.failPutsRemaining > 0) {
      if (this.failPutsRemaining > 0) this.failPutsRemaining -= 1;
      throw new Error("forced KV put failure");
    }
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    if (this.failDeletes || this.failDeletesRemaining > 0) {
      if (this.failDeletesRemaining > 0) this.failDeletesRemaining -= 1;
      throw new Error("forced KV delete failure");
    }
    this.store.delete(key);
  }

  list(options: { prefix: string }): Promise<{ keys: { name: string }[] }> {
    const keys = [...this.store.keys()]
      .filter((name) => name.startsWith(options.prefix))
      .map((name) => ({ name }));
    return Promise.resolve({ keys });
  }
}

export class RecordingWriterNamespace implements AssignmentWriterNamespace {
  readonly names: string[] = [];
  readonly bodies: unknown[] = [];

  constructor(
    private readonly result = {
      status: "stored",
      assignment: { runId: "run-1", variant: "control" },
    },
  ) {}

  idFromName(name: string): DurableObjectId {
    this.names.push(name);
    return name as unknown as DurableObjectId;
  }

  get(): { fetch: (_input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } {
    return {
      fetch: async (_input, init) => {
        this.bodies.push(JSON.parse(String(init?.body)));
        return Response.json(this.result);
      },
    };
  }
}

export class MapStorage implements AssignmentWriterStorage {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

export class RecordingAssignmentLogger implements AssignmentStoreLogger {
  readonly errors: { message: string; detail: unknown }[] = [];

  error(message: string, detail: unknown): void {
    this.errors.push({ message, detail });
  }
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>;
}
