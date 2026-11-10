"use client";

import { useActionState } from "react";
import { saveMovie, type OnboardingState } from "./actions";

export function OnboardingForm() {
  const [state, action, pending] = useActionState<OnboardingState, FormData>(saveMovie, {});

  return (
    <form action={action} className="flex w-full max-w-sm flex-col gap-3">
      <label htmlFor="movie" className="text-sm font-medium">
        What is your favorite movie?
      </label>
      <input
        id="movie"
        name="movie"
        type="text"
        required
        maxLength={200}
        autoComplete="off"
        aria-describedby={state.error ? "movie-error" : undefined}
        className="rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700"
      />
      {state.error && (
        <p id="movie-error" role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-foreground px-4 py-2 font-medium text-background disabled:opacity-60"
      >
        {pending ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}
