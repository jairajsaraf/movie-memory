import { Suspense } from "react";
import { redirect } from "next/navigation";
import { signOut } from "@/auth";
import { requireUser } from "@/lib/session";
import { FactCard, FactCardSkeleton } from "./fact-card";

export default async function DashboardPage() {
  const user = await requireUser();
  if (!user.favoriteMovie) redirect("/onboarding");

  // Missing Google name or photo falls back to the email prefix and an initial (D-04).
  const displayName = user.name ?? user.email?.split("@")[0] ?? "there";

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-8 p-8">
      <header className="flex items-center gap-3">
        {user.image ? (
          // eslint-disable-next-line @next/next/no-img-element -- remote Google avatar, no image optimizer needed
          <img src={user.image} alt="" referrerPolicy="no-referrer" className="size-10 rounded-full" />
        ) : (
          <span className="flex size-10 items-center justify-center rounded-full bg-zinc-200 font-medium dark:bg-zinc-800">
            {displayName.charAt(0).toUpperCase()}
          </span>
        )}
        <div className="flex-1">
          <p className="font-medium">{displayName}</p>
          {user.email && <p className="text-sm text-zinc-500">{user.email}</p>}
        </div>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
        >
          <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">
            Sign out
          </button>
        </form>
      </header>

      <section>
        <h1 className="text-sm uppercase tracking-wide text-zinc-500">Your favorite movie</h1>
        <p className="mt-1 text-3xl font-semibold">{user.favoriteMovie}</p>
      </section>

      <Suspense fallback={<FactCardSkeleton />}>
        <FactCard userId={user.id} />
      </Suspense>
    </main>
  );
}
