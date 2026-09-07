// Intercepted routes retain earlier task trees. Only the visible detail may
// receive the action; its actual composer trigger is intentionally CSS-hidden.
export function openVisibleActionPlanComposer(root: ParentNode = document): boolean {
  const contexts = Array.from(root.querySelectorAll<HTMLElement>("[data-task-quick-add-context]"));
  const context = contexts.findLast((element) => element.getClientRects().length > 0);
  if (!context) return false;
  const selectedTab = context.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  if (!selectedTab?.textContent?.trim().toLowerCase().startsWith("action plan")) return false;
  const trigger = context.querySelector<HTMLButtonElement>('[data-task-quick-action="action-plan"]');
  if (!trigger || trigger.disabled) return false;
  trigger.click();
  return true;
}
