import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db";

// The single auth check: every page and server action calls this. It returns the user as
// stored in the database (so `favoriteMovie` is never stale) or redirects to the landing page.
export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const user = await db.user.findUnique({ where: { id: session.user.id } });
  if (!user) redirect("/");
  return user;
}
