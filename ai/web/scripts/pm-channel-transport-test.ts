import assert from "node:assert/strict";
import {
  buildPmChannelIngressPayload,
  resolvePmChannelTransportMode,
  type PmChannelReplyTarget,
} from "@/lib/agents/pm-channel/openclaw";
import {
  pmChannelLatencyTransport,
  summarizePmLatencyByTransport,
} from "@/lib/agents/pm-channel/latency";

const target: PmChannelReplyTarget = {
  kind: "direct",
  agentSlug: "asdrubal",
  messageId: "transport-test-message",
};

const args = {
  gatewayPort: 65535,
  agentSlug: "asdrubal",
  sessionKey: "pm:test",
  kind: "direct" as const,
  text: "hello",
  actor: { id: "tester", username: "tester", kind: "human" as const },
  replyTarget: target,
};

function payloadFor(mode: string | undefined): Record<string, unknown> {
  delete process.env.PM_PM_CHANNEL_STREAM_SOCKET;
  delete process.env.PM_OPENCLAW_CHANNEL_STREAM_SOCKET;
  delete process.env.PM_CHANNEL_STREAM_SOCKET;
  if (mode == null) {
    delete process.env.PM_PM_CHANNEL_TRANSPORT;
    delete process.env.PM_OPENCLAW_CHANNEL_TRANSPORT;
  } else {
    process.env.PM_PM_CHANNEL_TRANSPORT = mode;
  }
  return buildPmChannelIngressPayload(args);
}

const httpBody = payloadFor(undefined);
assert.equal(resolvePmChannelTransportMode(), "http", "http is the safe default");
assert.equal(httpBody.streamTransport, "http");
assert.equal(typeof httpBody.streamUrl, "string", "http transport emits streamUrl");

const inprocBody = payloadFor("inproc");
assert.equal(resolvePmChannelTransportMode(), "inproc");
assert.equal(inprocBody.streamTransport, "inproc");
assert.equal(inprocBody.streamUrl, undefined, "inproc transport does not emit per-token HTTP streamUrl");

const udsBody = payloadFor("uds");
process.env.PM_PM_CHANNEL_STREAM_SOCKET = "/tmp/pm-channel-stream.sock";
const udsBodyWithSocket = buildPmChannelIngressPayload(args);
assert.equal(resolvePmChannelTransportMode(), "uds");
assert.equal(udsBody.streamTransport, "uds");
assert.equal(udsBody.streamUrl, undefined, "uds transport does not emit per-token HTTP streamUrl");
assert.equal(udsBodyWithSocket.streamSocketPath, "/tmp/pm-channel-stream.sock", "uds transport emits local socket path when configured");

const badBody = payloadFor("nonsense");
assert.equal(resolvePmChannelTransportMode(), "http", "unknown transport falls back to http");
assert.equal(badBody.streamTransport, "http");
assert.equal(typeof badBody.streamUrl, "string");

assert.equal(pmChannelLatencyTransport({
  driver: "openclaw-pm-channel:inproc",
  createdAt: new Date(0),
  acceptedAt: null,
  streamingAt: null,
  completedAt: new Date(10),
}), "inproc");

const byTransport = summarizePmLatencyByTransport([
  { driver: "openclaw-pm-channel:http", createdAt: new Date(0), acceptedAt: null, streamingAt: null, completedAt: new Date(100) },
  { driver: "openclaw-pm-channel:inproc", createdAt: new Date(0), acceptedAt: null, streamingAt: null, completedAt: new Date(20) },
  { driver: "openclaw-pm-channel:inproc", createdAt: new Date(0), acceptedAt: null, streamingAt: null, completedAt: new Date(40) },
]);
assert.equal(byTransport.http.count, 1);
assert.equal(byTransport.inproc.count, 2);
assert.equal(byTransport.inproc.maxMs, 40);

console.log("pm channel transport tests passed");
