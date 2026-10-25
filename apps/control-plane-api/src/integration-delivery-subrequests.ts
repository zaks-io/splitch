const REQUEST_METHODS = new Set<PropertyKey>([
  "batch",
  "run",
  "all",
  "first",
  "raw",
  "exec",
  "dump",
]);
const WRAPPED_METHODS = new Set<PropertyKey>(["prepare", "bind", "withSession"]);

export function integrationDeliverySubrequests(db: D1Database, fetcher: typeof fetch) {
  let d1 = 0;
  let http = 0;
  return {
    db: countD1(db, () => d1++),
    fetcher: ((...args) => {
      http++;
      return fetcher(...args);
    }) satisfies typeof fetch,
    get count() {
      return d1 + http;
    },
    get d1() {
      return d1;
    },
    get http() {
      return http;
    },
  };
}

function countD1<T extends object>(binding: T, onRequest: () => void): T {
  return new Proxy(binding, {
    get(target, method) {
      const value = Reflect.get(target, method, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (REQUEST_METHODS.has(method)) onRequest();
        const result = Reflect.apply(value, target, args);
        return WRAPPED_METHODS.has(method) ? countD1(result, onRequest) : result;
      };
    },
  });
}
