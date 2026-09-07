import assert from "node:assert/strict";
import { createViewerPolicyStream } from "../lib/viewer-policy-stream";
import { accessChangeListenerCount } from "../lib/users/access-change-hub";
import type { Viewer } from "../lib/auth/permissions";

// Exercise the bytes a proxy receives, including the quiet-policy case that
// previously timed out despite successful database polling. No live DB needed.
async function main() {
  const viewer = { id: "heartbeat-test" } as Viewer;
  let reads = 0;
  const stream = createViewerPolicyStream({
    viewerId: viewer.id,
    initialEpoch: 7,
    resolveViewer: async () => viewer,
    readEpoch: async () => { reads += 1; return 7; },
    heartbeatMs: 15,
  });
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = setTimeout(() => {
    void reader.cancel(new Error("idle policy stream sent no keepalive"));
  }, 2000);
  try {
    assert.equal(decoder.decode((await reader.read()).value), "event: policy-version\ndata: 7\n\n");
    for (let i = 0; i < 3; i += 1) {
      const next = await reader.read();
      assert.equal(next.done, false, "idle connection must remain open");
      assert.equal(decoder.decode(next.value), ": heartbeat\n\n", "keepalive must be a comment, not a policy-change event");
    }
    assert.ok(reads >= 2, "keepalives must retain durable policy checks");
  } finally {
    clearTimeout(deadline);
    await reader.cancel();
  }
  assert.equal(accessChangeListenerCount(viewer.id), 0, "disconnect releases the hub subscription");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const readsAfterCancel = reads;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(reads, readsAfterCancel, "disconnect stops the heartbeat");
  console.log("viewer policy wire heartbeat and disconnect cleanup passed");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
