import assert from "node:assert/strict";
import { openVisibleActionPlanComposer } from "../lib/client/action-plan-composer";

function detail({ visible = true, tab = "Action Plan", disabled = false, trigger = true } = {}) {
  let clicks = 0;
  const button = { disabled, click: () => { clicks += 1; }, getClientRects: () => [] };
  const element = {
    getClientRects: () => visible ? [{}] : [],
    querySelector: (selector: string) => selector.includes('role="tab"')
      ? { textContent: tab }
      : trigger ? button : null,
  } as unknown as HTMLElement;
  return { element, clicks: () => clicks };
}

const root = (...details: ReturnType<typeof detail>[]) => ({
  querySelectorAll: () => details.map((entry) => entry.element),
}) as unknown as ParentNode;

// The canonical task stays mounted before the intercepted, visible pane.
// A document-wide querySelector used to target that hidden tree.
const retained = detail({ visible: false });
const current = detail();
assert.equal(openVisibleActionPlanComposer(root(retained, current)), true);
assert.equal(retained.clicks(), 0, "never open a retained hidden task");
assert.equal(current.clicks(), 1, "open the visible task even though its trigger is CSS-hidden");

const description = detail({ tab: "Description" });
assert.equal(openVisibleActionPlanComposer(root(retained, description)), false,
  "wait for navigation to activate the visible Action Plan tab");
assert.equal(description.clicks(), 0);

const earlier = detail();
const pane = detail({ tab: "Action Plan 3" });
assert.equal(openVisibleActionPlanComposer(root(earlier, pane)), true);
assert.equal(earlier.clicks(), 0, "prefer the later intercepted detail when both trees have layout");
assert.equal(pane.clicks(), 1, "unread badges do not prevent opening");

assert.equal(openVisibleActionPlanComposer(root()), false);
assert.equal(openVisibleActionPlanComposer(root(retained)), false);
assert.equal(openVisibleActionPlanComposer(root(detail({ disabled: true }))), false);
assert.equal(openVisibleActionPlanComposer(root(detail({ trigger: false }))), false);
console.log("action-plan-composer: visible detail, tab readiness, and unavailable controls passed");
