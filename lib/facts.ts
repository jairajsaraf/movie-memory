import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

// Every time comparison uses the database's now(). Each statement below runs alone in
// autocommit, so now() is that statement's start; never wrap them in $transaction in app code.
export const CACHE_WINDOW_SECONDS = 60;
export const LEASE_SECONDS = 30;
// After a failed generation the lease stays blocked this long, so a fast-failing provider (429,
// 5xx) costs one attempt per user and movie per cooldown, not one per request.
export const FAILURE_COOLDOWN_SECONDS = 5;
const POLL_MS = 250;

type Sql = Prisma.TransactionClient;
export type StoredFact = { id: string; text: string; createdAt: Date };
export type FactResult =
  | { status: "fresh" | "generated" | "stale"; fact: StoredFact }
  | { status: "error"; message: string };

export const ERROR: FactResult = {
  status: "error",
  message: "We couldn't come up with a fact right now. Try refreshing in a minute.",
};

export async function findFreshFact(sql: Sql, userId: string, movie: string) {
  const rows = await sql.$queryRaw<StoredFact[]>`
    SELECT id, text, "createdAt" FROM "Fact"
    WHERE "userId" = ${userId} AND movie = ${movie}
      AND "createdAt" > now() - make_interval(secs => ${CACHE_WINDOW_SECONDS}::int)
    ORDER BY "createdAt" DESC LIMIT 1`;
  return rows[0] ?? null;
}

// One row back = this request may generate. The WHERE runs on the locked, latest row version
// after any conflict wait, so the decision never rests on a stale snapshot.
export async function claimLease(sql: Sql, userId: string, movie: string, token: string) {
  const rows = await sql.$queryRaw<unknown[]>`
    INSERT INTO "FactLease" ("userId", movie, token, "blockedUntil")
    VALUES (${userId}, ${movie}, ${token}::uuid, now() + make_interval(secs => ${LEASE_SECONDS}::int))
    ON CONFLICT ("userId", movie) DO UPDATE
      SET token = EXCLUDED.token, "blockedUntil" = EXCLUDED."blockedUntil"
      WHERE "FactLease"."blockedUntil" <= now()
    RETURNING token`;
  return rows.length === 1;
}

// Inserts the fact only if this request still holds the lease; the fact and the new
// blockedUntil (= createdAt + 60s) share one now(). Null = lease lost (zombie).
export async function finalizeFact(sql: Sql, userId: string, movie: string, token: string, text: string) {
  const rows = await sql.$queryRaw<StoredFact[]>`
    WITH won AS (
      UPDATE "FactLease"
      SET token = NULL, "blockedUntil" = now() + make_interval(secs => ${CACHE_WINDOW_SECONDS}::int)
      WHERE "userId" = ${userId} AND movie = ${movie} AND token = ${token}::uuid
      RETURNING "userId", movie
    )
    INSERT INTO "Fact" (id, "userId", movie, text, "createdAt")
    SELECT gen_random_uuid(), "userId", movie, ${text}, now() FROM won
    RETURNING id, text, "createdAt"`;
  return rows[0] ?? null;
}

export async function releaseLease(sql: Sql, userId: string, movie: string, token: string) {
  await sql.$executeRaw`
    UPDATE "FactLease"
    SET token = NULL, "blockedUntil" = now() + make_interval(secs => ${FAILURE_COOLDOWN_SECONDS}::int)
    WHERE "userId" = ${userId} AND movie = ${movie} AND token = ${token}::uuid`;
}

// Log shape for errors: never the message, headers or body, which can carry provider text. The
// OpenAI SDK's APIError has status, code, type and requestID (openai 7.54.0, core/error.d.ts).
export function describeError(err: unknown) {
  if (!(err instanceof Error)) return { name: typeof err };
  const e = err as { status?: unknown; code?: unknown; type?: unknown; requestID?: unknown };
  const pick = (v: unknown) => (typeof v === "string" || typeof v === "number" ? v : undefined);
  return { name: err.name, status: pick(e.status), code: pick(e.code), type: pick(e.type), requestID: pick(e.requestID) };
}

// One statement, one snapshot: finalize writes the fact and clears the token in one commit, so
// the poll sees both or neither.
async function pollWinner(userId: string, movie: string) {
  const [row] = await db.$queryRaw<(Partial<StoredFact> & { inFlight: boolean })[]>`
    SELECT f.id, f.text, f."createdAt",
      EXISTS (
        SELECT 1 FROM "FactLease"
        WHERE "userId" = ${userId} AND movie = ${movie} AND token IS NOT NULL AND "blockedUntil" > now()
      ) AS "inFlight"
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (
      SELECT id, text, "createdAt" FROM "Fact"
      WHERE "userId" = ${userId} AND movie = ${movie}
        AND "createdAt" > now() - make_interval(secs => ${CACHE_WINDOW_SECONDS}::int)
      ORDER BY "createdAt" DESC LIMIT 1
    ) f ON true`;
  return row;
}

// Most recent fact of any age for this user + movie, else a friendly error.
async function fallback(userId: string, movie: string): Promise<FactResult> {
  const fact = await db.fact.findFirst({
    where: { userId, movie },
    orderBy: { createdAt: "desc" },
    select: { id: true, text: true, createdAt: true },
  });
  return fact ? { status: "stale", fact } : ERROR;
}

export async function getFact(userId: string, generate: (movie: string) => Promise<string>): Promise<FactResult> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { favoriteMovie: true } });
  const movie = user?.favoriteMovie;
  if (!movie) return ERROR;

  const fresh = await findFreshFact(db, userId, movie);
  if (fresh) return { status: "fresh", fact: fresh };

  const token = randomUUID();
  if (await claimLease(db, userId, movie, token)) {
    let text: string;
    try {
      text = await generate(movie);
    } catch (err) {
      console.error("fact generation failed", describeError(err)); // server log only; the user gets the fallback
      await releaseLease(db, userId, movie, token);
      return fallback(userId, movie);
    }
    const fact = await finalizeFact(db, userId, movie, token, text);
    return fact ? { status: "generated", fact } : fallback(userId, movie);
  }

  // Lost the claim: wait for the winner instead of generating too.
  const deadline = Date.now() + LEASE_SECONDS * 1000;
  while (Date.now() < deadline) {
    const row = await pollWinner(userId, movie);
    if (row.id) return { status: "fresh", fact: row as StoredFact };
    if (!row.inFlight) break; // winner failed or its lease expired
    await sleep(POLL_MS);
  }
  return fallback(userId, movie);
}
