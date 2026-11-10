import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createUser, resetDb } from "./helpers";

// The variables a developer gets by copying .env.example (secrets there are empty placeholders).
const example = parseEnv(readFileSync(".env.example", "utf8"));

// next-auth reads its env (trustHost, URL) once when auth.ts is imported, so each test stubs the
// env first and imports a fresh copy.
async function loadAuth(env: Record<string, string | undefined>) {
  const base = {
    AUTH_SECRET: "test-only-secret-not-used-anywhere-else",
    AUTH_GOOGLE_ID: "test",
    AUTH_GOOGLE_SECRET: "test",
    AUTH_URL: undefined,
    AUTH_TRUST_HOST: undefined,
    VERCEL: undefined,
    CF_PAGES: undefined,
  };
  for (const [k, v] of Object.entries({ ...base, ...env })) vi.stubEnv(k, v);
  vi.resetModules();
  return import("@/auth");
}

async function seedSession() {
  const user = await createUser("Heat");
  const token = randomUUID();
  await db.session.create({
    data: { sessionToken: token, userId: user.id, expires: new Date(Date.now() + 86_400_000) },
  });
  return { user, token };
}

const sessionRequest = (token: string) =>
  new NextRequest("http://localhost:3000/api/auth/session", {
    headers: { cookie: `authjs.session-token=${token}` },
  });

beforeEach(resetDb);
afterEach(() => vi.unstubAllEnvs());
afterAll(() => db.$disconnect());

describe("GET /api/auth/session", () => {
  it("sends the browser only id, name, email and image, never the session token", async () => {
    const { handlers } = await loadAuth({});
    const { user, token } = await seedSession();

    const res = await handlers.GET(sessionRequest(token));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(body.user).toEqual({ id: user.id, name: null, email: user.email, image: null });
    expect(Object.keys(body).sort()).toEqual(["expires", "user"]);
  });

  it("works under NODE_ENV=production with the variables from .env.example", async () => {
    const { handlers } = await loadAuth({
      NODE_ENV: "production",
      AUTH_URL: example.AUTH_URL,
      AUTH_TRUST_HOST: example.AUTH_TRUST_HOST,
    });
    const { user, token } = await seedSession();

    const res = await handlers.GET(sessionRequest(token));

    expect(res.status).toBe(200);
    expect((await res.json()).user?.id).toBe(user.id);
  });
});
