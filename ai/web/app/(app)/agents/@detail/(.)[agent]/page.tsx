import AgentProfilePage from "../../[agent]/page";
import AgentPane from "@/components/agent-pane";

// Soft-navigating to an agent from the /agents hub intercepts the route here
// so the cards stay mounted in the children slot. The pane reuses the full
// agent profile page — no duplicated detail UI.
export default async function AgentDetailPane(props: {
  params: Promise<{ agent: string }>;
  searchParams?: Promise<{ tab?: string }>;
}) {
  return (
    <AgentPane>
      <AgentProfilePage params={props.params} searchParams={props.searchParams} />
    </AgentPane>
  );
}
