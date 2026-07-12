import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth/permissions";

export default async function SystemLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();
  if (!viewer?.isOwner) notFound();
  return children;
}
