import { redirect } from "next/navigation";

// The workspaces landing board *is* the home page. Keeping it mounted at
// /workspaces (rather than moving it to "/") preserves its parallel-route
// task interceptors and board chrome scope, so "/" just hands over.
export default async function HomePage() {
  redirect("/workspaces");
}
