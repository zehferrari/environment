// Heartbeats mean a known tool is still owned by this turn, not that it made
// progress. A finite silence ceiling leaves genuinely wedged tools recoverable.
export function createToolLiveness({ heartbeat, isActive = () => true, intervalMs = 30_000, maximumSilentMs = 15 * 60_000, now = Date.now, schedule = setInterval, cancel = clearInterval }) {
  const tools = new Map();
  let timer;
  let disposed = false;
  let sending = false;
  const stop = () => { if (timer) cancel(timer); timer = undefined; };
  const tick = async () => {
    if (disposed || !isActive()) { tools.clear(); stop(); return; }
    for (const [id, lastActivity] of tools) if (now() - lastActivity >= maximumSilentMs) tools.delete(id);
    if (!tools.size) { stop(); return; }
    if (sending) return;
    sending = true;
    try { await heartbeat(); } finally { sending = false; }
  };
  return {
    start(id) {
      if (disposed || !id) return;
      tools.set(id, now());
      if (!timer) { timer = schedule(() => void tick().catch(() => {}), intervalMs); timer?.unref?.(); }
    },
    finish(id) { tools.delete(id); if (!tools.size) stop(); },
    dispose() { disposed = true; tools.clear(); stop(); },
    tick,
  };
}
