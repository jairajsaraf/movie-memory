import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { OnboardingForm } from "./form";

export default async function OnboardingPage() {
  const user = await requireUser();
  if (user.favoriteMovie) redirect("/dashboard");

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-semibold">Welcome to Movie Memory</h1>
      <OnboardingForm />
    </main>
  );
}
