export type DiscussionOriginChannel = "chat" | "description";

export function discussionMessageCapabilities(args: {
  actorKind: "human" | "agent";
  canTriggerAgents: boolean;
  originChannel: DiscussionOriginChannel;
}) {
  const ownerAuthorized = args.actorKind === "human" && args.canTriggerAgents;
  return {
    allowDescriptionEdit: ownerAuthorized,
    // The dedicated description control is a direct, one-shot form-draft
    // write. It is deliberately not also a work-item proposal grant.
    allowWorkItemManagement: ownerAuthorized && args.originChannel !== "description",
  };
}
