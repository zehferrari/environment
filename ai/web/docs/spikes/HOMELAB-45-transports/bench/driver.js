// Spike support — HOMELAB-45. Driver process: spawns a receiver per
// transport, fires N envelopes, measures send-to-recv ns deltas, prints
// median / p50 / p95 / p99 / min / max + failure count.
//
// In-process is benchmarked here too: it doesn't need a receiver — we
// require() the handler directly and measure call-to-handler-tick.
//
// Spike-only.

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const RECEIVER = path.join(__dirname, 'receiver.js');
const N = Number(process.env.BENCH_N || 200);
const WARMUP = Number(process.env.BENCH_WARMUP || 20);
const LABEL = process.env.BENCH_LABEL || 'unknown';

function nowNs() {
  const [s, ns] = process.hrtime();
  return BigInt(s) * 1000000000n + BigInt(ns);
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => Number(a - b));
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

function summarise(name, deltas, failures) {
  const arr = deltas.filter(d => d != null);
  const median = arr.length ? pct(arr, 0.5) : 0n;
  const p95 = arr.length ? pct(arr, 0.95) : 0n;
  const p99 = arr.length ? pct(arr, 0.99) : 0n;
  const min = arr.length ? arr.reduce((a, b) => (a < b ? a : b)) : 0n;
  const max = arr.length ? arr.reduce((a, b) => (a > b ? a : b)) : 0n;
  return {
    label: LABEL,
    transport: name,
    n: arr.length,
    failures,
    median_us: Number(median / 1000n),
    p95_us: Number(p95 / 1000n),
    p99_us: Number(p99 / 1000n),
    min_us: Number(min / 1000n),
    max_us: Number(max / 1000n),
  };
}

async function spawnReceiver(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('node', [RECEIVER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = [];
    let buf = '';
    let ready = false;
    p.stdout.on('data', chunk => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith('READY ')) {
          ready = true;
          resolve({ proc: p, lines });
          continue;
        }
        lines.push(line);
      }
    });
    p.stderr.on('data', c => process.stderr.write(`[receiver:${args[0]}] ${c}`));
    p.on('exit', code => {
      if (!ready) reject(new Error(`receiver exit ${code} before READY`));
    });
    setTimeout(() => { if (!ready) reject(new Error('receiver did not become READY in 3s')); }, 3000);
  });
}

function parseRecvLines(lines) {
  // returns Map<seq:number, recv_ns:bigint>
  const m = new Map();
  for (const l of lines) {
    const [s, ns] = l.split(' ');
    if (s && ns) m.set(Number(s), BigInt(ns));
  }
  return m;
}

async function benchHttp() {
  const port = 19000 + Math.floor(Math.random() * 100);
  const { proc, lines } = await spawnReceiver(['http', String(port)]);
  const sendTimes = [];
  let failures = 0;
  // warmup
  for (let i = 0; i < WARMUP; i++) await postOne(port, -1);
  // measured
  for (let i = 0; i < N; i++) {
    const send = nowNs();
    try {
      await postOne(port, i);
      sendTimes[i] = send;
    } catch (_) { failures++; }
  }
  // give the receiver 200ms to flush
  await new Promise(r => setTimeout(r, 200));
  proc.kill();
  const recvMap = parseRecvLines(lines);
  const deltas = sendTimes.map((s, i) => {
    const r = recvMap.get(i);
    return r ? r - s : null;
  });
  return summarise('http', deltas, failures + deltas.filter(d => d == null).length);
}

function postOne(port, seq) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ seq });
    const req = http.request({
      method: 'POST', host: '127.0.0.1', port, path: '/',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => {
      res.on('data', () => {}); res.on('end', resolve);
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function benchUnix() {
  const sock = `/tmp/spike-bench-${process.pid}-${Date.now()}.sock`;
  const { proc, lines } = await spawnReceiver(['unix', sock]);
  const sendTimes = [];
  let failures = 0;
  const client = await new Promise((res, rej) => {
    const c = net.createConnection(sock, () => res(c));
    c.on('error', rej);
  });
  for (let i = 0; i < WARMUP; i++) {
    client.write(JSON.stringify({ seq: -1 }) + '\n');
  }
  for (let i = 0; i < N; i++) {
    const send = nowNs();
    client.write(JSON.stringify({ seq: i }) + '\n');
    sendTimes[i] = send;
  }
  await new Promise(r => setTimeout(r, 300));
  client.end();
  proc.kill();
  try { fs.unlinkSync(sock); } catch (_) {}
  const recvMap = parseRecvLines(lines);
  const deltas = sendTimes.map((s, i) => {
    const r = recvMap.get(i);
    return r ? r - s : null;
  });
  return summarise('unix', deltas, failures + deltas.filter(d => d == null).length);
}

async function benchFile() {
  const dir = `/tmp/spike-bench-files-${process.pid}-${Date.now()}`;
  fs.mkdirSync(dir, { recursive: true });
  const { proc, lines } = await spawnReceiver(['file', dir]);
  const sendTimes = [];
  let failures = 0;
  for (let i = 0; i < WARMUP; i++) {
    const f = path.join(dir, `warmup-${i}.json`);
    fs.writeFileSync(f, JSON.stringify({ seq: -1 }));
  }
  await new Promise(r => setTimeout(r, 200));
  for (let i = 0; i < N; i++) {
    const f = path.join(dir, `b-${i}.json`);
    const send = nowNs();
    fs.writeFileSync(f, JSON.stringify({ seq: i }));
    sendTimes[i] = send;
    // small spacing to avoid coalescing in fs.watch
    await new Promise(r => setImmediate(r));
  }
  await new Promise(r => setTimeout(r, 800));
  proc.kill();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  const recvMap = parseRecvLines(lines);
  const deltas = sendTimes.map((s, i) => {
    const r = recvMap.get(i);
    return r ? r - s : null;
  });
  return summarise('file', deltas, failures + deltas.filter(d => d == null).length);
}

async function benchInprocess() {
  // In-process: simulate "PM webapp imports OpenClaw client, calls a handler
  // synchronously". The receiver is a function in this same process.
  const sendTimes = [];
  const recvTimes = [];
  const handler = (env) => {
    recvTimes[env.seq] = nowNs();
  };
  for (let i = 0; i < WARMUP; i++) handler({ seq: -1 });
  for (let i = 0; i < N; i++) {
    const send = nowNs();
    handler({ seq: i });
    sendTimes[i] = send;
  }
  const deltas = sendTimes.map((s, i) => recvTimes[i] - s);
  return summarise('inprocess', deltas, 0);
}

(async () => {
  const results = [];
  results.push(await benchInprocess());
  results.push(await benchUnix());
  results.push(await benchHttp());
  results.push(await benchFile());
  for (const r of results) console.log(JSON.stringify(r));
})().catch(e => { console.error(e); process.exit(1); });
