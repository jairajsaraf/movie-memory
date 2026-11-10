import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { CACHE_WINDOW_SECONDS } from "@/lib/facts";

// Data-loss guard: never truncate anything but a *_test database.
export async function resetDb() {
  const [{ name }] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (!name.endsWith("_test")) throw new Error(`refusing to truncate database "${name}"`);
  await db.$executeRaw`TRUNCATE "User" CASCADE`;
}

export function createUser(favoriteMovie: string | null) {
  return db.user.create({ data: { email: `${randomUUID()}@test.local`, favoriteMovie } });
}

// Seeds a fact of the given age plus the lease row a real finalize would have left
// (blockedUntil = createdAt + 60s), in one statement so both use the same now().
export async function seedFact(
  userId: string,
  movie: string,
  ageSeconds: number,
  text: string,
  sql: Prisma.TransactionClient = db,
) {
  await sql.$executeRaw`
    WITH f AS (
      INSERT INTO "Fact" (id, "userId", movie, text, "createdAt")
      VALUES (gen_random_uuid(), ${userId}, ${movie}, ${text}, now() - make_interval(secs => ${ageSeconds}::float8))
      RETURNING "userId", movie, "createdAt"
    )
    INSERT INTO "FactLease" ("userId", movie, token, "blockedUntil")
    SELECT "userId", movie, NULL, "createdAt" + make_interval(secs => ${CACHE_WINDOW_SECONDS}::int) FROM f
    ON CONFLICT ("userId", movie) DO UPDATE SET token = NULL, "blockedUntil" = EXCLUDED."blockedUntil"`;
}

export function factCount(userId: string) {
  return db.fact.count({ where: { userId } });
}

export function getLease(userId: string, movie: string) {
  return db.factLease.findUnique({ where: { userId_movie: { userId, movie } } });
}

// Waits (no sleeps of fixed length) until some other backend is blocked on a row lock touching
// FactLease. A hard deadline keeps the interleave test from passing vacuously.
export async function waitForLockWait(deadlineMs = 3_000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const rows = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FactLease%'
        AND pid <> pg_backend_pid()`;
    if (rows[0].n > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no backend ever waited on a FactLease row lock");
}
