import type Database from 'better-sqlite3';

/**
 * Memoises an expensive derived value against a cheap fingerprint of the
 * annotations table.
 *
 * Intra-rater agreement has to decode four mask PNGs per repeat pair, which is
 * around 17 seconds for a full study — far too slow to run on every admin page
 * load. Annotations change slowly relative to how often the page is opened, so
 * the result is cached until the fingerprint moves.
 *
 * The fingerprint is (row count, latest updated_at). Any save touches
 * updated_at, and any new annotation moves the count, so the pair cannot go
 * stale while the data changes. It lives in process memory: a restart simply
 * recomputes, and a second server process would keep its own copy, which is
 * correct if slightly wasteful.
 */
export function memoiseOnAnnotations<T>(compute: (db: Database.Database) => T): (db: Database.Database) => T {
  let cachedFingerprint: string | null = null;
  let cached: T;

  return (db: Database.Database): T => {
    const row = db
      .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), :none) AS latest FROM annotations')
      .get({ none: 'never' }) as { n: number; latest: string };
    const fingerprint = `${row.n}:${row.latest}`;

    if (fingerprint !== cachedFingerprint) {
      cached = compute(db);
      cachedFingerprint = fingerprint;
    }
    return cached;
  };
}
