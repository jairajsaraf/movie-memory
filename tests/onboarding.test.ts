import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Only the edges are mocked: the session source and Next's redirect. requireUser, the action and
// the database are real.
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));

import { auth } from "@/auth";
import { saveMovie } from "@/app/onboarding/actions";
import { db } from "@/lib/db";
import { createUser, resetDb } from "./helpers";

const mockAuth = vi.mocked(auth as unknown as () => Promise<{ user: { id: string } } | null>);
const form = (movie: string) => {
  const f = new FormData();
  f.set("movie", movie);
  return f;
};
const movieOf = async (id: string) => (await db.user.findUnique({ where: { id } }))?.favoriteMovie;

beforeEach(resetDb);
afterAll(() => db.$disconnect());

describe("onboarding action authorization", () => {
  it("with no session redirects to / and writes nothing", async () => {
    const u = await createUser(null);
    mockAuth.mockResolvedValue(null);

    await expect(saveMovie({}, form("Heat"))).rejects.toThrow("REDIRECT /");
    expect(await movieOf(u.id)).toBeNull();
  });

  it("cannot overwrite a movie that is already set", async () => {
    const u = await createUser("Heat");
    mockAuth.mockResolvedValue({ user: { id: u.id } });

    await expect(saveMovie({}, form("Alien"))).rejects.toThrow("REDIRECT /dashboard");
    expect(await movieOf(u.id)).toBe("Heat");
  });

  it("sets the movie, normalized, for a signed-in user without one", async () => {
    const u = await createUser(null);
    mockAuth.mockResolvedValue({ user: { id: u.id } });

    await expect(saveMovie({}, form("  The   Thing "))).rejects.toThrow("REDIRECT /dashboard");
    expect(await movieOf(u.id)).toBe("The Thing");
  });

  it("rejects invalid input without writing", async () => {
    const u = await createUser(null);
    mockAuth.mockResolvedValue({ user: { id: u.id } });

    const r = await saveMovie({}, form("   "));
    expect(r.error).toBeTruthy();
    expect(await movieOf(u.id)).toBeNull();
  });
});
