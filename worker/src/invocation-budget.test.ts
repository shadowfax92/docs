import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInvocationResources, InvocationBudgetExceeded } from "./invocation-budget";
import { createLibraryFixture } from "./library-index.test-support";

/** Native workerd resources verify receiver and statement identity. Rejected writes are checked
 * against the original resources, outside the wrapper; no SQL or storage operation is simulated.
 */
describe("one invocation's combined D1/R2 budget", () => {
  let fixture: Awaited<ReturnType<typeof createLibraryFixture>>;
  beforeAll(async () => { fixture = await createLibraryFixture(); }, 20_000);
  afterAll(async () => { await fixture?.dispose(); });
  const resources = () => createInvocationResources(() => fixture.db, fixture.bucket);

  it("preserves prepared/bound native statements and atomic batch semantics", async () => {
    const scope = resources();
    const bound = scope.db.prepare("SELECT ? AS value").bind("native receiver");
    expect(scope.budget.used).toBe(0);
    expect(await bound.first("value")).toBe("native receiver");
    const result = await scope.db.batch([
      scope.db.prepare("SELECT ? AS value").bind(7), scope.db.prepare("SELECT ? AS value").bind(9),
    ]);
    expect(result.map((entry) => entry.results)).toEqual([[{ value: 7 }], [{ value: 9 }]]);
    expect(await bound.raw()).toEqual([["native receiver"]]);
    expect(await bound.all()).toMatchObject({ results: [{ value: "native receiver" }] });
    expect(await bound.run()).toMatchObject({ success: true });
    expect(scope.budget).toMatchObject({ used: 6, remaining: 34 });
    await expect(scope.db.batch([fixture.db.prepare("SELECT 1")])).rejects.toThrow(/belong/);
    expect(scope.budget.used).toBe(6);
    await expect(scope.db.exec("CREATE TABLE forbidden_exec (id INTEGER); SELECT 1;")).rejects.toThrow(/Unsupported/);
    expect(await fixture.db.prepare("SELECT name FROM sqlite_master WHERE name = 'forbidden_exec'").first()).toBeNull();
    expect(scope.budget.used).toBe(6);
  });

  it("shares actual opaque R2 calls and deferred work without resetting a new invocation", async () => {
    const scope = resources();
    await scope.bucket.put("Budget01/native.txt", "body");
    const object = await scope.bucket.get("Budget01/native.txt");
    expect(await object?.text()).toBe("body");
    expect(scope.budget.used).toBe(2);
    await scope.bucket.head("Budget01/native.txt");
    await scope.bucket.list({ prefix: "Budget01/" });
    await Promise.resolve().then(async () => {
      await scope.db.prepare("SELECT ? AS value").bind("deferred").first();
      await scope.bucket.delete("Budget01/native.txt");
    });
    expect(scope.budget).toMatchObject({ used: 6, remaining: 34 });
    expect(resources().budget).toMatchObject({ used: 0, remaining: 40 });
  });

  it("rejects an entire batch or R2 operation before I/O at normal40, reserving only cleanup to total50", async () => {
    const scope = resources();
    await scope.db.batch(Array.from({ length: 39 }, () => scope.db.prepare("SELECT 1")));
    await expect(scope.db.batch([
      scope.db.prepare("CREATE TABLE forbidden_batch (id INTEGER)"), scope.db.prepare("SELECT 2"),
    ])).rejects.toBeInstanceOf(InvocationBudgetExceeded);
    expect(await fixture.db.prepare("SELECT name FROM sqlite_master WHERE name = 'forbidden_batch'").first()).toBeNull();
    expect(scope.budget).toMatchObject({ used: 39, remaining: 1 });
    await scope.bucket.head("Budget01/missing");
    await expect(scope.bucket.put("Budget01/rejected.txt", "must not commit")).rejects.toBeInstanceOf(InvocationBudgetExceeded);
    expect(await fixture.bucket.get("Budget01/rejected.txt")).toBeNull();
    expect(scope.budget).toMatchObject({ used: 40, remaining: 0 });
    expect(await scope.budget.finalize(async () => {
      await scope.db.batch(Array.from({ length: 9 }, () => scope.db.prepare("SELECT 1")));
      await scope.bucket.head("Budget01/missing");
      await expect(scope.db.prepare("SELECT 1").first()).rejects.toBeInstanceOf(InvocationBudgetExceeded);
      return "checkpointed";
    })).toBe("checkpointed");
    expect(scope.budget).toMatchObject({ used: 50, remaining: 0 });
    await expect(scope.bucket.head("Budget01/missing")).rejects.toBeInstanceOf(InvocationBudgetExceeded);
  });

  it("counts admitted backend failures and restores normal admission after failed cleanup", async () => {
    const scope = resources();
    await expect(scope.db.prepare("SELECT * FROM nonexistent_budget_table").all()).rejects.toThrow();
    expect(scope.budget.used).toBe(1);
    await scope.db.batch(Array.from({ length: 39 }, () => scope.db.prepare("SELECT 1")));
    await expect(scope.budget.finalize(async () => {
      await scope.db.prepare("SELECT 1").first();
      throw new Error("checkpoint failed");
    })).rejects.toThrow("checkpoint failed");
    expect(scope.budget.used).toBe(41);
    await expect(scope.db.prepare("SELECT 1").first()).rejects.toBeInstanceOf(InvocationBudgetExceeded);
  });

  it("rejects nested cleanup and cleanup racing unsettled normal work", async () => {
    const scope = resources();
    const outstanding = scope.db.prepare("SELECT 1").all();
    await expect(scope.budget.finalize(async () => "too early")).rejects.toThrow(/serialized/);
    await outstanding;
    await scope.budget.finalize(async () => {
      await expect(scope.budget.finalize(async () => "nested")).rejects.toThrow(/serialized/);
      await scope.db.prepare("SELECT 2").first();
    });
    expect(scope.budget.used).toBe(2);
  });

  it("rejects multi-statement prepared objects before I/O at both caps", async () => {
    await fixture.db.prepare("CREATE TABLE budget_multi (value INTEGER)").run();
    const scope = resources();
    await scope.db.batch(Array.from({ length: 39 }, () => scope.db.prepare("SELECT 1")));
    const multi = "INSERT INTO budget_multi VALUES (1); " + "INSERT INTO budget_multi VALUES (2); ".repeat(11);
    expect(() => scope.db.prepare(multi)).toThrow(/one complete SQL statement/);
    expect(scope.budget.used).toBe(39);
    expect(await fixture.db.prepare("SELECT COUNT(*) AS count FROM budget_multi").first("count")).toBe(0);
    // Quoted/commented semicolons are data, including doubled quotes and bound values.
    expect(await scope.db.prepare("SELECT 'literal;''quote' AS value /* ; */").first("value")).toBe("literal;'quote");
    await scope.budget.finalize(async () => {
      await scope.db.batch(Array.from({ length: 10 }, () => scope.db.prepare("SELECT 1")));
      expect(() => scope.db.prepare(multi)).toThrow(/one complete SQL statement/);
      expect(scope.budget.used).toBe(50);
    });
    for (const sql of ["SELECT 1; SELECT 2", "SELECT 1; /* comment */ SELECT 2", "SELECT 'unterminated", "SELECT 1 /* unfinished", "SELECT 1\0; SELECT 2"]) {
      expect(() => scope.db.prepare(sql)).toThrow(/one complete SQL statement/);
    }
    expect(await fixture.db.prepare("SELECT COUNT(*) AS count FROM budget_multi").first("count")).toBe(0);
  });

  it("does not resolve the D1 binding for auth/public R2-only work", async () => {
    const scope = createInvocationResources(() => { throw new Error("DB binding must remain lazy"); }, fixture.bucket);
    await scope.bucket.head("Budget01/missing");
    expect(scope.budget.used).toBe(1);
  });
});
