export const MOVIE_MAX_LENGTH = 200;

export type ParsedMovie = { ok: true; value: string } | { ok: false; error: string };

// Trim, collapse whitespace runs, then require 1..200 characters. Runs on the server only.
export function parseMovie(input: unknown): ParsedMovie {
  const value = typeof input === "string" ? input.trim().replace(/\s+/g, " ") : "";
  if (!value) return { ok: false, error: "Please enter a movie title." };
  if (value.length > MOVIE_MAX_LENGTH) {
    return { ok: false, error: `Movie titles can be at most ${MOVIE_MAX_LENGTH} characters.` };
  }
  // Postgres text columns cannot store NUL; without this the write throws a 500.
  if (value.includes("\u0000")) return { ok: false, error: "Please enter a valid movie title." };
  return { ok: true, value };
}
