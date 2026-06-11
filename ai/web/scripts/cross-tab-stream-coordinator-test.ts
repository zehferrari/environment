import assert from "node:assert/strict";
import { CrossTabStreamCoordinator } from "../lib/agents/cross-tab-stream-coordinator";

type Listener = (event: MessageEvent<any>) => void;

const channels = new Map<string, Set<FakeBroadcastChannel>>();

class FakeBroadcastChannel {
  private listeners = new Set<Listener>();

  constructor(private readonly name: string) {
    let peers = channels.get(name);
    if (!peers) {
      peers = new Set();
      channels.set(name, peers);
    }
    peers.add(this);
  }

  postMessage(message: any) {
    const peers = channels.get(this.name) ?? new Set();
    queueMicrotask(() => {
      peers.forEach((peer) => {
        if (peer === this) return;
        peer.listeners.forEach((listener) => listener({ data: message } as MessageEvent<any>));
      });
    });
  }

  addEventListener(_type: "message", listener: Listener) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: Listener) {
    this.listeners.delete(listener);
  }

  close() {
    channels.get(this.name)?.delete(this);
    this.listeners.clear();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, label: string) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function main() {
  let randomSeed = 0;
  const options = {
    heartbeatMs: 20,
    staleLeaderMs: 80,
    claimJitterMs: 1,
    createBroadcastChannel: (name: string) => new FakeBroadcastChannel(name),
    random: () => {
      randomSeed += 0.01;
      return randomSeed;
    },
  };

  const a = new CrossTabStreamCoordinator<{ value: string }>("test-stream", options);
  const b = new CrossTabStreamCoordinator<{ value: string }>("test-stream", options);
  await waitFor(() => a.isLeader() || b.isLeader(), "initial leader election");
  await sleep(40);
  assert.equal([a.isLeader(), b.isLeader()].filter(Boolean).length, 1, "exactly one tab becomes leader");

  const leader = a.isLeader() ? a : b;
  const follower = leader === a ? b : a;
  let followerState: { value: string } | null = null;
  let followerLastEventId = "";
  follower.onState(({ state, lastEventId }) => {
    followerState = state;
    followerLastEventId = lastEventId;
  });
  leader.publishState({ value: "first" }, "42");
  await waitFor(() => followerState?.value === "first", "state fan-out");
  assert.deepEqual(followerState, { value: "first" });
  assert.equal(followerLastEventId, "42");

  leader.close();
  await waitFor(() => follower.isLeader(), "stale leader failover");

  a.close();
  b.close();
  console.log("cross-tab stream coordinator tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
