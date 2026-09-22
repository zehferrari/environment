// systemd's active state precedes the gateway HTTP listener and plugin startup.
export async function waitForPmGatewayReady({ agent, port, token, isActive, fetchImpl = fetch,
  wait = () => new Promise((resolve) => setTimeout(resolve, 1000)), attempts = 30 }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) throw new Error(`${agent}: missing PM gateway readiness configuration`);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (isActive()) {
      try {
        const response = await fetchImpl(`http://127.0.0.1:${port}/pm-channel/capabilities`, {
          headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500),
        });
        const body = response.ok ? await response.json() : null;
        if (Array.isArray(body?.taskRuntimeVersions) && Array.isArray(body?.taskTools)) return;
      } catch { /* Startup is not ready; do not expose credential-bearing requests. */ }
    }
    if (attempt + 1 < attempts) await wait();
  }
  throw new Error(`${agent}: authenticated PM channel did not become ready after restart`);
}
