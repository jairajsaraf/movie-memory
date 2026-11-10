import { ERROR, getFact, type FactResult } from "@/lib/facts";
import { generateFact } from "@/lib/openai";

// Rendered inside <Suspense>. Any error (database included) becomes the friendly variant, so
// nothing from it reaches the page (D-09). The fact is React text, never HTML (D-06).
export async function FactCard({ userId }: { userId: string }) {
  let result: FactResult;
  try {
    result = await getFact(userId, generateFact);
  } catch (err) {
    console.error("getFact failed", err);
    result = ERROR;
  }

  return (
    <section className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
      <h2 className="text-sm uppercase tracking-wide text-zinc-500">Fun fact</h2>
      {result.status === "error" ? (
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">{result.message}</p>
      ) : (
        <>
          <p className="mt-2 text-lg">{result.fact.text}</p>
          {result.status === "stale" && (
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
              Couldn&apos;t get a new fact, so this is an earlier one.
            </p>
          )}
          <p className="mt-3 text-xs text-zinc-500">AI-generated, may be inaccurate.</p>
        </>
      )}
    </section>
  );
}

export function FactCardSkeleton() {
  return (
    <section className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800" aria-busy="true">
      <h2 className="text-sm uppercase tracking-wide text-zinc-500">Fun fact</h2>
      <p className="mt-2 text-zinc-500">Finding a fact…</p>
    </section>
  );
}
