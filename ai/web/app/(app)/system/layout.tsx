import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth/permissions";

export default async function SystemLayout({ children }: { children: React.ReactNode }) {
  // Per-page gating (ENV-164): each System page enforces its own access —
  // /system/users admits the Owner and Admins (Admins see a scoped view),
  // while activity, settings, and the access-audit trail stay Owner-only.
  // Anonymous visitors never get past this layout.
  const viewer = await getViewer();
  if (!viewer) notFound();
  return children;
}
