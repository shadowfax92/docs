/** One invocation's combined D1-statement/R2-operation ledger, including waitUntil work. The
 * resources returned with it are the only handles passed to Documents, auth and LibraryIndex.
 * No caller charges again: opaque Documents traversals and atomic D1 batches are counted here.
 */
export interface InvocationBudget {
  readonly used: number;
  readonly remaining: number;
  /** Run serialized checkpoint/status/lease cleanup after all normal work has settled. Nested
   * scopes and outstanding I/O are rejected; the ten-operation reserve never resets the ledger. */
  finalize<T>(work: () => Promise<T>): Promise<T>;
}
export class InvocationBudgetExceeded extends Error {
  constructor() { super("The invocation resource budget is exhausted."); this.name = "InvocationBudgetExceeded"; }
}

/** Lazily resolve D1 so public reads and login never need a database binding. Native methods keep
 * their original receiver, and batch unwraps only this ledger's statements before one atomic call.
 */
export function createInvocationResources(database: () => D1Database, bucket: R2Bucket): {
  readonly db: D1Database; readonly bucket: R2Bucket; readonly budget: InvocationBudget;
} {
  let used = 0;
  let pending = 0;
  let finalizing = false;
  let db: D1Database | undefined;
  const statements = new WeakMap<object, D1PreparedStatement>();
  function admit(count: number) {
    if (!Number.isSafeInteger(count) || count < 0 || used + count > (finalizing ? 50 : 40)) throw new InvocationBudgetExceeded();
    used += count;
  }
  async function io<T>(count: number, work: () => Promise<T>): Promise<T> {
    admit(count);
    pending++;
    try { return await work(); } finally { pending--; }
  }
  const budget: InvocationBudget = {
    get used() { return used; },
    get remaining() { return Math.max(0, 40 - used); },
    async finalize(work) {
      if (finalizing || pending) throw new Error("Invocation cleanup must be serialized after settled work.");
      finalizing = true;
      try {
        const result = await work();
        if (pending) throw new Error("Invocation cleanup must await every operation.");
        return result;
      } finally { finalizing = false; }
    },
  };
  function statement(native: D1PreparedStatement): D1PreparedStatement {
    const wrapped = new Proxy(native, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => statement(target.bind(...values));
        if (["first", "all", "run", "raw"].includes(String(property))) {
          return (...args: unknown[]) => io(1, async () => Reflect.apply(Reflect.get(target, property, target), target, args));
        }
        const value = Reflect.get(target, property, target);
        if (typeof value === "function") return () => { throw new Error("Unsupported budgeted D1 statement operation."); };
        return value;
      },
    });
    statements.set(wrapped, native);
    return wrapped;
  }
  function databaseHandle<T extends D1Database | D1DatabaseSession>(native: T): T {
    return new Proxy(native, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => statement(target.prepare(sql));
        if (property === "batch") return async (batch: D1PreparedStatement[]) => {
          const raw = batch.map((entry) => {
            const original = statements.get(entry);
            if (!original) throw new Error("Batch statements must belong to this invocation.");
            return original;
          });
          return io(raw.length, () => target.batch(raw));
        };
        if (property === "withSession" && "withSession" in target) {
          return (...args: unknown[]) => databaseHandle(Reflect.apply(target.withSession, target, args));
        }
        if (property === "getBookmark" && "getBookmark" in target) return target.getBookmark.bind(target);
        const value = Reflect.get(target, property, target);
        // exec may contain arbitrarily many statements. Never guess a parser/accounting rule.
        if (typeof value === "function") return async () => { throw new Error("Unsupported budgeted D1 database operation."); };
        return value;
      },
    });
  }
  function multipart(native: R2MultipartUpload): R2MultipartUpload {
    return new Proxy(native, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        return typeof value === "function"
          ? (...args: unknown[]) => io(1, async () => Reflect.apply(value, target, args)) : value;
      },
    });
  }
  const wrappedBucket = new Proxy(bucket, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "resumeMultipartUpload") return (...args: unknown[]) => multipart(Reflect.apply(value, target, args));
      if (property === "createMultipartUpload") return (...args: unknown[]) => io(1, async () => multipart(await Reflect.apply(value, target, args)));
      if (["get", "head", "list", "put", "delete"].includes(String(property))) {
        return (...args: unknown[]) => io(1, async () => Reflect.apply(value, target, args));
      }
      if (typeof value === "function") return () => { throw new Error("Unsupported budgeted R2 operation."); };
      return value;
    },
  });
  return { budget, bucket: wrappedBucket, get db() { return db ??= databaseHandle(database()); } };
}
