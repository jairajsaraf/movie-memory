"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { parseMovie } from "@/lib/movie";
import { requireUser } from "@/lib/session";

export type OnboardingState = { error?: string };

// Set-once (D-05): the WHERE clause only matches a user with no movie yet, so a double submit or a
// second tab is harmless. The user id comes from the session, never from the form.
export async function saveMovie(_prev: OnboardingState, formData: FormData): Promise<OnboardingState> {
  const user = await requireUser();

  const parsed = parseMovie(formData.get("movie"));
  if (!parsed.ok) return { error: parsed.error };

  await db.user.updateMany({
    where: { id: user.id, favoriteMovie: null },
    data: { favoriteMovie: parsed.value },
  });
  redirect("/dashboard");
}
