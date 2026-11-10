import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";

export default async function Home() {
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-4xl font-semibold">Movie Memory</h1>
      <p className="max-w-md text-zinc-600 dark:text-zinc-400">
        Tell us your favorite movie and get a fun fact about it.
      </p>
      <form
        action={async () => {
          "use server";
          await signIn("google", { redirectTo: "/dashboard" });
        }}
      >
        <button
          type="submit"
          className="rounded-md bg-foreground px-5 py-2.5 font-medium text-background hover:opacity-90"
        >
          Sign in with Google
        </button>
      </form>
    </main>
  );
}
