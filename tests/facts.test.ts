import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { claimLease, finalizeFact, findFreshFact, getFact, releaseLease } from "@/lib/facts";
import { createUser, factCount, getLease, resetDb, seedFact, waitForLockWait } from "./helpers";

beforeEach(resetDb);
afterAll(() => db.$disconnect());

const ok = (text: string) => vi.fn(async () => text);
const failing = () =>
  vi.fn(async (): Promise<string> => {
    throw new Error("upstream 500 sk-leak-secret");
  });

describe("cache window", () => {
  it("returns a 59s-old fact without generating", async () => {
    const u = await createUser("Heat");
    await seedFact(u.id, "Heat", 59, "cached");
    const generate = ok("new");

    const r = await getFact(u.id, generate);

    expect(r).toMatchObject({ status: "fresh", fact: { text: "cached" } });
    expect(generate).not.toHaveBeenCalled();
    expect(await factCount(u.id)).toBe(1);
  });

  it.each([60, 61])("regenerates when the fact is %is old", async (age) => {
    const u = await createUser("Heat");
    await seedFact(u.id, "Heat", age, "old");
    const generate = ok("new");

    const r = await getFact(u.id, generate);

    expect(r).toMatchObject({ status: "generated", fact: { text: "new" } });
    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith("Heat");
    expect(await factCount(u.id)).toBe(2);
  });

  // One transaction freezes now(), so this hits the boundary exactly instead of 60s + latency.
  it("at exactly 60s the fact is not fresh and the lease is claimable; 1µs younger it is the reverse", async () => {
    const exact = await createUser("Heat");
    const younger = await createUser("Heat");
    await db.$transaction(async (tx) => {
      for (const [u, age] of [[exact, "60"], [younger, "59.999999"]] as const) {
        await tx.$executeRaw`
          WITH f AS (
            INSERT INTO "Fact" (id, "userId", movie, text, "createdAt")
            VALUES (gen_random_uuid(), ${u.id}, 'Heat', 'x', now() - make_interval(secs => ${age}::float8))
            RETURNING "createdAt"
          )
          INSERT INTO "FactLease" ("userId", movie, token, "blockedUntil")
          SELECT ${u.id}, 'Heat', NULL, "createdAt" + interval '60 seconds' FROM f`;
      }
      expect(await findFreshFact(tx, exact.id, "Heat")).toBeNull();
      expect(await claimLease(tx, exact.id, "Heat", randomUUID())).toBe(true);
      expect(await findFreshFact(tx, younger.id, "Heat")).not.toBeNull();
      expect(await claimLease(tx, younger.id, "Heat", randomUUID())).toBe(false);
    });
  });

  it("a movie change is a cache miss", async () => {
    const u = await createUser("Alien");
    await seedFact(u.id, "Heat", 1, "heat fact");
    const generate = ok("alien fact");

    const r = await getFact(u.id, generate);

    expect(r).toMatchObject({ status: "generated", fact: { text: "alien fact" } });
    expect(generate).toHaveBeenCalledWith("Alien");
  });

  it("returns an error for a user who has not picked a movie", async () => {
    const u = await createUser(null);
    const generate = ok("x");
    expect(await getFact(u.id, generate)).toMatchObject({ status: "error" });
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("generation failure", () => {
  it("falls back to the most recent fact of any age and releases the lease", async () => {
    const u = await createUser("Heat");
    await seedFact(u.id, "Heat", 300, "older");
    await seedFact(u.id, "Heat", 120, "newest stale");

    const r = await getFact(u.id, failing());

    expect(r).toMatchObject({ status: "stale", fact: { text: "newest stale" } });
    const lease = await getLease(u.id, "Heat");
    expect(lease?.token).toBeNull();
    // Released with a cooldown: an immediate retry falls back instead of calling the provider.
    const early = ok("too early");
    expect(await getFact(u.id, early)).toMatchObject({ status: "stale", fact: { text: "newest stale" } });
    expect(early).not.toHaveBeenCalled();
    // Once the cooldown has passed the next request may generate again.
    await db.$executeRaw`UPDATE "FactLease" SET "blockedUntil" = now() - interval '1 second'
      WHERE "userId" = ${u.id} AND movie = 'Heat'`;
    const retry = ok("recovered");
    expect(await getFact(u.id, retry)).toMatchObject({ status: "generated", fact: { text: "recovered" } });
  });

  it("staggered requests during an outage make one provider call per cooldown, not one each", async () => {
    const u = await createUser("Heat");
    const generate = failing();

    const results = [];
    for (let i = 0; i < 5; i++) results.push(await getFact(u.id, generate));

    expect(generate).toHaveBeenCalledOnce();
    expect(results.every((r) => r.status === "error")).toBe(true);
  });

  it("logs only a redacted summary of the provider error", async () => {
    const u = await createUser("Heat");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = Object.assign(new Error("upstream 500 sk-leak-secret"), { status: 500, requestID: "req_1" });
      await getFact(u.id, async () => {
        throw err;
      });
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).toContain("req_1");
      expect(logged).not.toContain("sk-leak");
      expect(logged).not.toContain("upstream");
    } finally {
      spy.mockRestore();
    }
  });

  it("returns a friendly error with no provider detail when nothing is cached", async () => {
    const u = await createUser("Heat");

    const r = await getFact(u.id, failing());

    expect(r.status).toBe("error");
    expect(JSON.stringify(r)).not.toContain("sk-leak");
    expect(JSON.stringify(r)).not.toContain("upstream");
  });

  it("does not fall back to a fact for a different movie", async () => {
    const u = await createUser("Alien");
    await seedFact(u.id, "Heat", 120, "heat fact");

    const r = await getFact(u.id, failing());

    expect(r.status).toBe("error");
  });
});

describe("authorization", () => {
  it("user B never gets user A's fact or uses A's lease for the same title", async () => {
    const a = await createUser("Heat");
    const b = await createUser("Heat");
    await seedFact(a.id, "Heat", 1, "A's fact");
    const leaseBefore = await getLease(a.id, "Heat");
    const generate = ok("B's fact");

    const r = await getFact(b.id, generate);

    expect(r).toMatchObject({ status: "generated", fact: { text: "B's fact" } });
    expect(generate).toHaveBeenCalledOnce();
    expect(await getLease(a.id, "Heat")).toEqual(leaseBefore);
    expect(await factCount(a.id)).toBe(1);
  });
});

describe("burst protection", () => {
  it("20 parallel requests make one generate call and one new row, all showing the same fact", async () => {
    const u = await createUser("Heat");
    // Slow enough that every request reaches the claim while the winner is still generating.
    const generate = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 500));
      return "the one fact";
    });

    const results = await Promise.all(Array.from({ length: 20 }, () => getFact(u.id, generate)));

    expect(generate).toHaveBeenCalledOnce();
    expect(await factCount(u.id)).toBe(1);
    for (const r of results) expect(r).toMatchObject({ fact: { text: "the one fact" } });
    expect(results.filter((r) => r.status === "generated")).toHaveLength(1);
  });

  it("a zombie whose lease expired and was taken over can neither insert nor release", async () => {
    const u = await createUser("Heat");
    let takeoverLease: Awaited<ReturnType<typeof getLease>> = null;
    const zombieGenerate = vi.fn(async () => {
      // Our lease expires mid-generation; another request takes over and finishes.
      await db.$executeRaw`UPDATE "FactLease" SET "blockedUntil" = now() - interval '1 second'
        WHERE "userId" = ${u.id} AND movie = 'Heat'`;
      const takeover = await getFact(u.id, ok("takeover fact"));
      expect(takeover).toMatchObject({ status: "generated" });
      takeoverLease = await getLease(u.id, "Heat");
      return "zombie fact";
    });

    const r = await getFact(u.id, zombieGenerate);

    expect(r).toMatchObject({ status: "stale", fact: { text: "takeover fact" } });
    expect(await factCount(u.id)).toBe(1);
    expect(await getLease(u.id, "Heat")).toEqual(takeoverLease);
  });

  it("a zombie that failed does not release the new holder's lease", async () => {
    const u = await createUser("Heat");
    const zombie = randomUUID();
    const holder = randomUUID();
    expect(await claimLease(db, u.id, "Heat", zombie)).toBe(true);
    await db.$executeRaw`UPDATE "FactLease" SET "blockedUntil" = now() - interval '1 second'
      WHERE "userId" = ${u.id} AND movie = 'Heat'`;
    expect(await claimLease(db, u.id, "Heat", holder)).toBe(true);

    await releaseLease(db, u.id, "Heat", zombie);

    expect((await getLease(u.id, "Heat"))?.token).toBe(holder);
    expect(await claimLease(db, u.id, "Heat", randomUUID())).toBe(false);
  });

  // The race that broke the plan's delete-based SQL: a claim that starts while a
  // finalize is uncommitted must, after waiting on the row lock, see the finalized row.
  it("claim blocked behind an uncommitted finalize returns no lease", async () => {
    const u = await createUser("Heat");
    const winner = randomUUID();
    // Winner holds an already-expired lease, so only the finalized row version can block the claim.
    await db.$executeRaw`INSERT INTO "FactLease" ("userId", movie, token, "blockedUntil")
      VALUES (${u.id}, 'Heat', ${winner}::uuid, now() - interval '1 second')`;

    let claim!: Promise<boolean>;
    await db.$transaction(
      async (tx) => {
        expect(await finalizeFact(tx, u.id, "Heat", winner, "winner fact")).not.toBeNull();
        claim = claimLease(db, u.id, "Heat", randomUUID());
        await waitForLockWait();
      },
      { timeout: 10_000 },
    );

    expect(await claim).toBe(false);
    expect(await factCount(u.id)).toBe(1);
  });
});
