// Spike support — HOMELAB-45. Receiver-side processes for each transport.
// Owns the listener for a single transport and ack-reports first-tick wall
// time per inbound envelope so the driver can compute delta.
//
// Spike-only: this code is throwaway, not part of any production wake path.
// See ../memo.md for the decision context.

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');

const transport = process.argv[2];
const arg = process.argv[3];

function nowNs() {
  const [s, ns] = process.hrtime();
  return BigInt(s) * 1000000000n + BigInt(ns);
}

function emit(line) {
  // Single line per envelope: `<seq> <recv_ns>`
  process.stdout.write(line + '\n');
}

if (transport === 'http') {
  const port = Number(arg);
  const srv = http.createServer((req, res) => {
    const recv = nowNs();
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const seq = JSON.parse(body || '{}').seq;
      emit(`${seq} ${recv}`);
      res.writeHead(204);
      res.end();
    });
  });
  srv.listen(port, '127.0.0.1', () => emit(`READY ${port}`));
} else if (transport === 'unix') {
  const sockPath = arg;
  try { fs.unlinkSync(sockPath); } catch (_) {}
  const srv = net.createServer(conn => {
    let buf = '';
    conn.on('data', chunk => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const recv = nowNs();
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const seq = JSON.parse(line).seq;
          emit(`${seq} ${recv}`);
        } catch (_) {}
      }
    });
  });
  srv.listen(sockPath, () => emit(`READY ${sockPath}`));
} else if (transport === 'file') {
  const dir = arg;
  fs.mkdirSync(dir, { recursive: true });
  // chokidar would be more robust; we use raw fs.watch here to keep the
  // benchmark dep-free. The OS-level cost being measured is identical.
  const seen = new Set();
  fs.watch(dir, (event, filename) => {
    const recv = nowNs();
    if (!filename || seen.has(filename)) return;
    seen.add(filename);
    const full = path.join(dir, filename);
    try {
      const data = fs.readFileSync(full, 'utf8');
      const seq = JSON.parse(data).seq;
      emit(`${seq} ${recv}`);
    } catch (_) {}
  });
  emit(`READY ${dir}`);
} else {
  console.error(`unknown transport ${transport}`);
  process.exit(2);
}
