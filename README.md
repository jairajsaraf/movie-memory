# Movie Memory

Sign in with Google, name your favorite movie, and get a fun fact about it from OpenAI. This is my
take-home submission, **Variant A (backend: caching and correctness)**: a 60-second fact cache that
uses the database clock, with burst protection that holds across tabs and server instances.

Stack: TypeScript, Next.js 16 (App Router), React 19, Tailwind, Postgres 17, Prisma 7, Auth.js v5
(Google, database sessions), OpenAI Responses API (`gpt-6-luna`). All versions are pinned exactly.

## What is and is not verified

Read this first, so nothing below is oversold.

- **Verified by running:** 28 Vitest tests against a real Postgres, `tsc --noEmit` and `eslint`, all
  clean. Output is pasted in [docs/verification.md](docs/verification.md).
- **Checked by hand, not by a test:** the redirects (`/dashboard` without a session goes to `/`; no
  movie goes to `/onboarding`; a set movie goes to `/dashboard`). I ran those against `next dev`
  with a session row seeded in the database. There is no Playwright test; I deferred it.
- **Checked by hand in a browser (2026-11-10, `next dev`, real Google account and OpenAI key):**
  Google sign-in, the onboarding form, the dashboard (name, email, photo, movie), sign-out, signing
  in again straight to the dashboard, and a live `gpt-6-luna` fact. A refresh soon after showed the
  same fact (the dev log shows a ~100 ms request after a ~2 s one); a refresh after 60 s showed a
  new one. The dev log had no OpenAI or auth errors. Not covered by a test, and not run under
  `npm start`.

## Setup

You need Node 24 (I ran 24.18.1), npm, and Docker.

1. Start Postgres. The first start also creates the `movie_memory_test` database the tests use.

   ```bash
   docker compose up -d
   ```

2. Create `.env` **before** `npm install`. `postinstall` runs `prisma generate`, which reads
   `DATABASE_URL`.

   ```bash
   cp .env.example .env
   ```

   Fill in the variables in the next section.

3. Install, migrate, run.

   ```bash
   npm install
   npm run db:migrate
   npm run dev
   ```

   Open http://localhost:3000.

For a production-mode run, use `npm run build` then `npm start`. `AUTH_URL` must match the origin you
open (see below), or Auth.js rejects every request as an untrusted host.

## Environment variables

Copy `.env.example`; every variable below is in it. `.env` is git-ignored.

| Variable | What it is | Where to get it |
|---|---|---|
| `DATABASE_URL` | Postgres connection string for the app. | The default in `.env.example` matches `docker-compose.yml`. |
| `TEST_DATABASE_URL` | A separate database the test suite truncates. | Default in `.env.example`; must differ from `DATABASE_URL` or Vitest refuses to start. |
| `AUTH_SECRET` | Signs Auth.js cookies and tokens. | Run `openssl rand -base64 33`. |
| `AUTH_URL` | The app's origin, `http://localhost:3000` locally. | Change it if you use another host or port. |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | Google OAuth client. | Google Cloud Console, APIs & Services, Credentials, Create OAuth client ID, type Web application. Add the authorized redirect URI `http://localhost:3000/api/auth/callback/google`. |
| `OPENAI_API_KEY` | Used only by `lib/openai.ts`, which imports `server-only`. | https://platform.openai.com/api-keys |

## Database migrations

The schema is one migration, `prisma/migrations/20261110031731_init`. Apply it with:

```bash
npm run db:migrate
```

That runs `prisma migrate deploy`. The test suite applies the same migration to
`TEST_DATABASE_URL` itself (`tests/global-setup.ts`). If your Docker volume predates the test
database, create it once: `docker compose exec db psql -U postgres -c "CREATE DATABASE movie_memory_test"`.

## Tests

```bash
npm test
npm run typecheck
npm run lint
```

`npm test` needs Docker running and `TEST_DATABASE_URL` set. It uses a real Postgres, not mocks,
because the claims under test are about SQL, row locks and the database clock. The tests never call
OpenAI: `getFact` takes the generator as a parameter and the tests pass a fake. Ages are seeded with
`now() - interval`, not by sleeping.

## Architecture

### Pages and auth

- `/` shows the landing page with "Sign in with Google"; a signed-in user is redirected on.
- `/onboarding` asks for the favorite movie. `/dashboard` shows name, email, photo (with fallbacks),
  the movie, sign-out, and the fact card.
- "First-time" means `User.favoriteMovie` is null in the database, read on every request. A user who
  abandons onboarding lands back on it. The dashboard redirects to `/onboarding` when it is null,
  and `/onboarding` redirects to `/dashboard` when it is set.
- One helper, `requireUser()` in `lib/session.ts`, is the auth check. Every page and server action
  calls it, and no user id ever comes from the client. There is no `proxy.ts`; with database
  sessions it would either duplicate this check or add a second database lookup.
- Onboarding validates on the server (`lib/movie.ts`: trim, collapse whitespace, 1 to 200
  characters, no NUL) and writes with `WHERE id = <session user> AND favoriteMovie IS NULL`, so the
  movie is set once and a double submit does nothing.
- The session callback returns an allow-list (id, name, email, image, expiry). The adapter's
  session object carries the raw session token, and Auth.js would send it to page JavaScript.

### Data model

- `User` has `favoriteMovie` (varchar 200, nullable), plus the Auth.js tables.
- `Fact(id, userId, movie, text, createdAt)` is insert-only. `movie` is a snapshot of the title the
  fact was written for, so "latest fact for this user and movie" is one index read, and a movie
  change is a cache miss with no invalidation code. The cache is a query over `Fact`, not a second
  store.
- `FactLease(userId, movie, token, blockedUntil)` has the primary key `(userId, movie)` and is never
  deleted. `blockedUntil` says when a new generation for that pair may next start. `token` is set
  only while a generation is in flight.
- All time columns are `timestamptz(6)`. Prisma's default `DateTime` is `timestamp(3)`, which would
  round the two tables differently and blur the 60-second boundary.

### One request: `getFact` in `lib/facts.ts`

```text
getFact(userId, generate)
 |
 |- read user.favoriteMovie ........ none -> friendly error
 |
 |- 1. fresh fact for (user, movie), createdAt > now() - 60s ?
 |       yes -> return it                                                 [fresh]
 |
 |- 2. claim the lease (one statement):
 |      INSERT ... ON CONFLICT (userId, movie) DO UPDATE ... WHERE blockedUntil <= now()
 |       |
 |       |- 1 row back (this request won)
 |       |     generate(movie), outside any transaction, 20s cap
 |       |       |- ok    -> finalize (one statement): set lease blockedUntil = now() + 60s
 |       |       |           and insert the Fact, only if the lease token is still mine
 |       |       |             |- inserted -> return it                   [generated]
 |       |       |             |- 0 rows (lease was taken over) -> fallback
 |       |       |- throws -> release the lease -> fallback
 |       |
 |       |- 0 rows back (another request holds the lease, or a fact is fresh)
 |             poll every 250ms for up to 30s, one SQL statement per poll:
 |               fresh fact appeared -> return it                         [fresh]
 |               no fact and lease no longer in flight -> fallback
 |
 fallback = newest Fact for (user, movie) of any age       -> [stale]
            none                                           -> [error], friendly message only
```

Why this shape:

- **The database decides, and it uses its own clock.** Every comparison and every stored time uses
  Postgres `now()`, so app servers with skewed clocks cannot disagree. A fact is fresh when its age is
  strictly under 60 seconds; the lease becomes claimable at exactly 60. Those two conditions are
  exact complements.
- **The claim decides on one locked row.** Under READ COMMITTED, an `INSERT ... ON CONFLICT DO
  UPDATE` that hits an uncommitted row waits for it, then re-evaluates its `WHERE` against the
  latest committed version. My first design deleted the lease on finalize and put a "no fresh fact"
  check in the claim. That check is read once from the statement's snapshot and is not re-run
  after the wait, so a second request could generate seconds after the first. The test `claim blocked behind an uncommitted finalize returns no
  lease` reproduces it deterministically, and it failed against the old SQL.
- **Nothing is held during the OpenAI call.** No transaction and no pooled connection stay open
  while waiting. A lease with a 30-second expiry stands in for "in progress", and the finalize
  checks the token, so a slow request whose lease was taken over cannot insert a second fact.
- **Failures are contained.** The OpenAI client gets one attempt with a 20-second timeout and no
  retries, so the lease outlives the call. Provider error text goes to the server log and never to
  the page. The fact card catches any error from `getFact`, database errors included.

### OpenAI

`lib/openai.ts` calls the Responses API with fixed instructions and the movie title as data, with
`reasoning.effort = "none"` (a one-sentence fact needs no reasoning, and `max_output_tokens` counts
reasoning tokens). It throws on an incomplete or empty response, and caps the text at 600
characters. The page renders it as React text, never HTML, under the label "AI-generated, may be
inaccurate".

## Variant A, and why

I chose A because its hard part has a right answer I can reason about and test against a real
database: a cache window with an exact boundary, and a race that does not show up in a happy-path
demo. I preferred depth on that to breadth across a typed client, optimistic edits and frontend
tests (Variant B). The cost is that there is no edit-movie flow and no client-side state work.

I picked the lease-row ("generation in progress" flag with expiry) over three other options:
an advisory lock holds a transaction and a pooled connection for the whole OpenAI call, a
unique constraint per 60-second bucket breaks at bucket edges (facts at 0:59 and 1:01 land in
different buckets 2 seconds apart), and an in-memory lock fails with more than one instance.

## Key tradeoffs

- **Freshness is measured from the finalize statement,** not from when the user saw the fact. The
  difference is milliseconds.
- **No negative caching.** During an OpenAI outage each burst of requests makes one attempt, not one
  per tab, but a later burst tries again.
- **A loser can wait up to 30 seconds** behind a slow winner (the dashboard shows a skeleton), and a
  crashed process leaves that user and movie on the fallback for up to 30 seconds.
- **Facts accumulate,** about one row per user per minute at worst, with no retention policy.
- **Three statements are raw SQL.** As far as I know, Prisma's `upsert` has no conditional update, so
  `ON CONFLICT ... DO UPDATE ... WHERE` needs raw SQL (I did not re-check the docs for this). They
  are parameterised tagged templates, and none may be wrapped in `$transaction`, because `now()`
  would freeze at the transaction start.
- **The movie is set once.** Onboarding is first-time only and Variant A adds no edit flow.
- **Fully dynamic rendering.** Every page is per-user, so I turned Next's Cache Components off.
  The 60-second database cache is the only cache.
- **Tests need Docker.** I took that over mocks that cannot prove anything about locks or time.
- **Auth.js v5 is a beta** (`5.0.0-beta.32`). It works with the Prisma 7 adapter here (proved first),
  but it is pinned for that reason.
- **Local only.** A host needs a request time limit above 30 seconds, because a loser can wait that
  long.

## With 2 more hours

1. **Playwright e2e for the auth flow,** using a seeded session row and cookie plus a seeded fresh
   fact so no OpenAI call happens: landing, `/dashboard` guard, first-time vs returning, sign-out.
2. **`next build`, then grep `.next/static`** for key patterns and secret variable names. Today
   the only guard is `import "server-only"` in `lib/openai.ts`.
3. **Two test-strength gaps from review.** The authorization test does not reach the loser's poll
   and fallback queries (both filter on `userId`, and the code is correct). The 20-parallel test does
   not assert that the 19 losers got `fresh`.
4. **Fact retention,** for example keep the newest few per user and movie.
5. **A circuit breaker** so an OpenAI outage costs one attempt per window, not one per burst.

## Note on AI usage

- I used Claude (in Claude Code) as the main implementer. It wrote the plan, most of the code, the
  tests and the docs. Before any work started I fixed the variant, the auth library and session
  strategy, and the model.
- I reviewed the design at a checkpoint before any app code existed, and made the calls on
  open choices there: lease row over advisory lock, no `proxy.ts`, and deferring Playwright and the
  build grep.
- While designing the lock, the assistant found that its own first SQL raced under READ COMMITTED.
  The tests were written to fail on the broken
  version, and `docs/verification.md` lists each guard I broke on purpose to watch a test fail.
- Review was done by assistant subagents. Two reviewers critiqued the design. At the end four
  reviewers (correctness, security, adversarial concurrency, a fresh read of the PDF) ran in
  parallel and a separate skeptic tried to refute each finding. Three real issues came out (a
  session-token leak in the session JSON, no sign-in under `npm start`, a NUL character crashing
  the write), each fixed test-first.
- Library facts (Prisma 7, Auth.js, the OpenAI Responses API, Postgres locking) were read from their
  docs or source.

## Docs map

- [docs/verification.md](docs/verification.md): what was run and what it showed.
