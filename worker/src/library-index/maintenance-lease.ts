import type { LibraryDependencies, MaintenanceLease } from "./contracts";

/** One nonce owns a maintenance invocation. Expiry permits takeover, never authorizes
 * cleanup by the old runner; every checkpoint/renew/release compares live ownership in SQL.
 */
export async function acquireMaintenanceLease(deps: LibraryDependencies, duration: number): Promise<MaintenanceLease | null> {
  const now = deps.now();
  const lease = { token: deps.nonce(), expiresAt: now + 2 * duration };
  const result = await deps.db.prepare(`INSERT INTO index_meta(key, value, token, expires_at)
    VALUES ('maintenance-lease', '', ?, ?)
    ON CONFLICT(key) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
    WHERE index_meta.expires_at <= ?`).bind(lease.token, lease.expiresAt, now).run();
  return result.meta.changes === 1 ? lease : null;
}

export const liveLeaseSQL = `EXISTS (SELECT 1 FROM index_meta WHERE key = 'maintenance-lease'
  AND token = ? AND expires_at > ?)`;

export async function renewMaintenanceLease(deps: LibraryDependencies, lease: MaintenanceLease, duration: number): Promise<boolean> {
  const now = deps.now();
  const expires = now + 2 * duration;
  const result = await deps.db.prepare(`UPDATE index_meta SET expires_at = ? WHERE key = 'maintenance-lease'
    AND token = ? AND expires_at > ?`).bind(expires, lease.token, now).run();
  if (result.meta.changes !== 1) return false;
  lease.expiresAt = expires;
  return true;
}

export async function releaseMaintenanceLease(deps: LibraryDependencies, lease: MaintenanceLease): Promise<void> {
  await deps.db.prepare(`DELETE FROM index_meta WHERE key = 'maintenance-lease' AND token = ? AND expires_at > ?`)
    .bind(lease.token, deps.now()).run();
}

/** Cursor/storage writes are difference-only housekeeping. An expired worker cannot save
 * old progress over a successor; a zero-change write also avoids unnecessary row billing.
 */
export async function saveMaintenanceMeta(deps: LibraryDependencies, lease: MaintenanceLease,
  entries: ReadonlyArray<readonly [string, string]>): Promise<void> {
  const now = deps.now();
  if (!entries.length) return;
  const values = entries.map(() => "(?, ?)").join(", ");
  await deps.db.prepare(`WITH entries(key, value) AS (VALUES ${values})
    INSERT INTO index_meta(key, value) SELECT key, value FROM entries WHERE ${liveLeaseSQL}
    ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE index_meta.value <> excluded.value`)
    .bind(...entries.flatMap(([key, value]) => [key, value]), lease.token, now).run();
}
