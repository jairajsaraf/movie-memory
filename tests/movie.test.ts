import { describe, expect, it } from "vitest";
import { parseMovie } from "@/lib/movie";

describe("parseMovie (D-05)", () => {
  it("trims surrounding whitespace", () => {
    expect(parseMovie("  Heat  ")).toEqual({ ok: true, value: "Heat" });
  });

  it("collapses internal whitespace runs to one space", () => {
    expect(parseMovie("The   Lord\t of\nthe Rings")).toEqual({
      ok: true,
      value: "The Lord of the Rings",
    });
  });

  it("rejects a NUL character, which Postgres text columns cannot store", () => {
    expect(parseMovie("Heat\u0000").ok).toBe(false);
  });

  it("rejects empty and whitespace-only input", () => {
    expect(parseMovie("").ok).toBe(false);
    expect(parseMovie(" \t\n ").ok).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(parseMovie(null).ok).toBe(false);
    expect(parseMovie(42).ok).toBe(false);
  });

  it("accepts exactly 200 characters and rejects 201", () => {
    expect(parseMovie("a".repeat(200)).ok).toBe(true);
    expect(parseMovie("a".repeat(201)).ok).toBe(false);
  });

  it("measures length after trimming and collapsing", () => {
    expect(parseMovie(`  ${"a".repeat(200)}  `).ok).toBe(true);
  });

  it("returns a user-facing message on failure", () => {
    const r = parseMovie("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/movie/i);
  });
});
