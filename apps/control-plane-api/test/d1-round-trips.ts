export function countD1RoundTrips(d1: D1Database) {
  const statements: string[][] = [];
  const queries = new WeakMap<D1PreparedStatement, string>();
  const binding = new Proxy(d1, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => wrap(target.prepare(query), query);
      }
      if (property === "batch") {
        return (batch: D1PreparedStatement[]) => {
          statements.push(
            batch.map((statement) => {
              const query = queries.get(statement);
              if (!query) throw new Error("D1 counter received an unrecorded statement");
              return query;
            }),
          );
          return target.batch(batch);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  function wrap(statement: D1PreparedStatement, query: string): D1PreparedStatement {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), query);
        }
        const value = Reflect.get(target, property);
        if (["all", "raw", "run", "first"].includes(String(property))) {
          return (...args: unknown[]) => {
            statements.push([query]);
            return value.apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    queries.set(wrapped, query);
    return wrapped;
  }

  return {
    d1: binding,
    statements,
    reset: () => {
      statements.length = 0;
    },
  };
}
