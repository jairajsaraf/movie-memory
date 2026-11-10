# Verification

What was run and what it showed. All runs were on 2026-11-09, on Node 24.18.1 with PostgreSQL
17.11 (`postgres:17-alpine` from `docker-compose.yml`). Phases 2 and 3 were recorded at
`1f939ca`. The Vitest output below is the re-run after the Phase 4 review fixes. Statements are **confirmed** (I ran it and read the output), or listed
under "Not verified".

## How to reproduce

```bash
docker compose up -d
```

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run lint
```

`npm test` needs `TEST_DATABASE_URL` (see `.env.example`). `vitest.config.mts` refuses to start if
it is unset, equals `DATABASE_URL`, or names a database that does not end in `_test` (checked
before any migration runs; it reads the URL, it does not ask the server). `tests/helpers.ts`
refuses to truncate any database whose name does not end in `_test`. `tests/global-setup.ts`
applies the migrations to the test database first.

## Vitest: 30 passed

`npx vitest run --reporter=verbose`, exit code 0:

```text
 ✓ tests/facts.test.ts > cache window > returns a 59s-old fact without generating 165ms
 ✓ tests/facts.test.ts > cache window > regenerates when the fact is 60s old 32ms
 ✓ tests/facts.test.ts > cache window > regenerates when the fact is 61s old 32ms
 ✓ tests/facts.test.ts > cache window > at exactly 60s the fact is not fresh and the lease is claimable; 1µs younger it is the reverse 34ms
 ✓ tests/facts.test.ts > cache window > a movie change is a cache miss 31ms
 ✓ tests/facts.test.ts > cache window > returns an error for a user who has not picked a movie 16ms
 ✓ tests/facts.test.ts > generation failure > falls back to the most recent fact of any age and releases the lease 73ms
 ✓ tests/facts.test.ts > generation failure > staggered requests during an outage make one provider call per cooldown, not one each 67ms
 ✓ tests/facts.test.ts > generation failure > logs only a redacted summary of the provider error 30ms
 ✓ tests/facts.test.ts > generation failure > returns a friendly error with no provider detail when nothing is cached 28ms
 ✓ tests/facts.test.ts > generation failure > does not fall back to a fact for a different movie 32ms
 ✓ tests/facts.test.ts > authorization > user B never gets user A's fact or uses A's lease for the same title 36ms
 ✓ tests/facts.test.ts > burst protection > 20 parallel requests make one generate call and one new row, all showing the same fact 621ms
 ✓ tests/facts.test.ts > burst protection > a zombie whose lease expired and was taken over can neither insert nor release 56ms
 ✓ tests/facts.test.ts > burst protection > a zombie that failed does not release the new holder's lease 43ms
 ✓ tests/facts.test.ts > burst protection > claim blocked behind an uncommitted finalize returns no lease 40ms
 ✓ tests/auth-session.test.ts > GET /api/auth/session > sends the browser only id, name, email and image, never the session token 410ms
 ✓ tests/auth-session.test.ts > GET /api/auth/session > works under NODE_ENV=production with the variables from .env.example 34ms
 ✓ tests/onboarding.test.ts > onboarding action authorization > with no session redirects to / and writes nothing 169ms
 ✓ tests/onboarding.test.ts > onboarding action authorization > cannot overwrite a movie that is already set 32ms
 ✓ tests/onboarding.test.ts > onboarding action authorization > sets the movie, normalized, for a signed-in user without one 25ms
 ✓ tests/onboarding.test.ts > onboarding action authorization > rejects invalid input without writing 21ms
 ✓ tests/movie.test.ts > parseMovie > trims surrounding whitespace 3ms
 ✓ tests/movie.test.ts > parseMovie > collapses internal whitespace runs to one space 0ms
 ✓ tests/movie.test.ts > parseMovie > rejects a NUL character, which Postgres text columns cannot store 1ms
 ✓ tests/movie.test.ts > parseMovie > rejects empty and whitespace-only input 0ms
 ✓ tests/movie.test.ts > parseMovie > rejects non-string input 0ms
 ✓ tests/movie.test.ts > parseMovie > accepts exactly 200 characters and rejects 201 0ms
 ✓ tests/movie.test.ts > parseMovie > measures length after trimming and collapsing 0ms
 ✓ tests/movie.test.ts > parseMovie > returns a user-facing message on failure 0ms
 Test Files  4 passed (4)
      Tests  30 passed (30)
```

After a failed generation the lease stays blocked for `FAILURE_COOLDOWN_SECONDS` (5 s), so a
fast-failing provider costs one attempt per user and movie per cooldown. Provider errors are
logged as a redacted summary (name, status, code, type, request ID), never the message, headers
or body; "logs only a redacted summary of the provider error" asserts that. These two tests and
the `_test` name check in `vitest.config.mts` were added after an independent static review
(2026-11-10); with the cooldown set to 0, the staggered-requests test and the failure test fail.
The redaction test was not mutation-checked.

### What the tests stand on

- **Real database, no mocks.** `getFact` takes `generate` as a parameter, so the tests pass a fake
  and never call OpenAI. The SQL, the clock and the locks are the real ones.
- **Ages are seeded with `now() - interval`.** The seed also writes the matching `FactLease` row
  (`blockedUntil = createdAt + 60s`), the same state a real finalize leaves. A test that seeded
  only the fact would exercise just the fast path.
- **The 60s and 61s seeds are checked a few milliseconds later**, so their real age is 60s plus
  latency. The exact boundary is the separate test that runs inside one transaction: `now()` is
  frozen there, and the age is exactly 60s or exactly 59.999999s.
- **The 20-parallel test's fake `generate` waits 500ms.** All 20 requests therefore reach the
  claim while the winner is still generating, so passing on the fast path alone is impossible.
- **The interleave test** holds a finalize open in a transaction and fires a claim. It waits
  until `pg_stat_activity` shows that claim blocked on a lock (3s hard deadline, so the test cannot
  pass without the block happening), then commits and asserts the claim got no lease.
- **The onboarding tests mock only `@/auth` (the session source) and `next/navigation` (redirect).**
  `requireUser`, the server action and the database are real.

## Each guard was seen to fail

The facts and onboarding suites passed on their first run. A test never seen failing proves
nothing, so each guard was broken on purpose and the suite re-run. The code was then restored and
checked against the original (`cmp`).

| Change made | Result |
|---|---|
| Interleave test run against the plan's original delete-based lease SQL (temporary test file, since removed) | **fails**: the blocked claim returned 1 row, i.e. a second generation while the first fact was seconds old. |
| Claim without `WHERE "FactLease"."blockedUntil" <= now()` | 4 fail: 20-parallel, interleave, exactly-60s, zombie-release |
| Finalize without the `token = $token` check | 1 fails: zombie insert |
| Release without the `token = $token` check | 1 fails: zombie release |
| Freshness `>` changed to `>=` | 1 fails: exactly-60s |
| Onboarding update without `favoriteMovie: null` in the `WHERE` | 1 fails: cannot overwrite |
| Onboarding action reading the first user instead of `requireUser()` | 1 fails: no session |

The three Phase 4 review fixes were written test-first. Each test failed
on the old code:

| Test | Failure before the fix |
|---|---|
| "sends the browser only id, name, email and image, never the session token" | the response body contained the raw session token |
| "works under NODE_ENV=production with the variables from .env.example" | `500`, logged `[auth][error] UntrustedHost: Host must be trusted` |
| "rejects a NUL character, which Postgres text columns cannot store" | `parseMovie("Heat\u0000").ok` was `true` |

The first run of `tests/auth-session.test.ts` failed for a different reason: Node could not resolve
`next/server` from inside next-auth. That was fixed in the test setup (`server.deps.inline` in
`vitest.config.mts`), and the tests were re-run to get the failures above.

## Type check and lint

`npx tsc --noEmit`: exit code 0, no output.

`npx eslint`: exit code 0, no output.

## Manual smoke test: dashboard fact card

`next dev` was run against the dev database with a session row seeded by hand. The request
sent its token as the `authjs.session-token` cookie, and `OPENAI_API_KEY` was unset so generation
would fail. `GET /dashboard`:

- The HTML streamed the skeleton ("Finding a fact…") and then the friendly error variant.
- The server log has `fact generation failed Error: Missing credentials…`.
- The page HTML contains neither "Missing credentials" nor "apiKey" (grep count 0).

The seeded rows were deleted afterwards. Earlier, in Phase 2, a seeded session
resolved through `auth()`, with these redirects: no cookie → `/`; no movie → `/onboarding`; movie
set → 200; `/onboarding` with a movie → `/dashboard`.

## Not verified

- Nothing from the earlier list remains. Not run: `npm start`, and a timed (to the second) check
  of the 60 s boundary.

## Confirmed by hand, 2026-11-10

Run by the owner in their own browser against `next dev` on `localhost:3000`, with a real Google
OAuth client (test user) and a real OpenAI key. I read the dev server log (OAuth codes not quoted).

- **Confirmed:** Google sign-in, then `/dashboard` redirected to `/onboarding` on first visit;
  `POST /onboarding` saved the movie; the dashboard showed name, email, photo and movie.
- **Confirmed:** sign-out returned to the landing page; signing in again went to `/dashboard`
  (200) with no onboarding redirect.
- **Confirmed:** a live `gpt-6-luna` call produced a fact (~3 s request). A refresh soon after
  returned the same fact (~114 ms request); a refresh after 60 s returned a different fact (~2 s
  request). No OpenAI 401/404/429 and no `UntrustedHost` in the log.
- **Inferred:** the hydration warning in the dev overlay comes from a browser extension (the
  injected `bis_*` attributes), not the app.

## Deferred by the owner

- Playwright end-to-end tests of the UI auth flow. It is to be checked by hand instead.
- `next build` followed by a grep of `.next/static` for key patterns. Until then, the only
  evidence that the key stays server-side is `import "server-only"` at the top of `lib/openai.ts`,
  which turns any client import into a build error. That is **inferred** from the `server-only`
  package's documented behaviour; it was not tested here.
