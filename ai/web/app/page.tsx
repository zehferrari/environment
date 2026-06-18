import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import AppLayout from "./(app)/layout";
import ProjectsPage from "./(app)/projects/page";

export default async function HomePage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  return (
    <AppLayout>
      <ProjectsPage />
    </AppLayout>
  );
}
