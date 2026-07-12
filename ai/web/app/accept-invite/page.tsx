import { redirect } from "next/navigation";
export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token = "" } = await searchParams;
  if (!token) redirect("/login");
  redirect(`/set-password?token=${encodeURIComponent(token)}`);
}
