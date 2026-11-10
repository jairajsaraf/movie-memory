import { z } from "zod";

export const MOVIE_MAX_LENGTH = 200;

// Trim, collapse whitespace runs, then require 1..200 characters. Runs on the server only.
const movieSchema = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(1, "Please enter a movie title.")
      .max(MOVIE_MAX_LENGTH, `Movie titles can be at most ${MOVIE_MAX_LENGTH} characters.`)
      // Postgres text columns cannot store NUL; without this the write throws a 500.
      .refine((s) => !s.includes("\u0000"), "Please enter a valid movie title."),
  );

export type ParsedMovie = { ok: true; value: string } | { ok: false; error: string };

export function parseMovie(input: unknown): ParsedMovie {
  const r = movieSchema.safeParse(input);
  return r.success
    ? { ok: true, value: r.data }
    : { ok: false, error: r.error.issues[0]?.message ?? "Please enter a valid movie title." };
}
