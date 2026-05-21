# HOMELAB-45 spike — zero-latency agent trigger architecture

Decision/research only — no Stage 3 implementation, no PR.

Files:

- `memo.md` — the deliverable. Scored comparison + recommendation +
  residual risks. Start here.
- `bench/` — spike-support harness. Throwaway, do **not** import into
  HOMELAB-46. See `memo.md` § "Bench" for caveats.
- `results/raw.jsonl` — raw bench output, 3 trials × N=200.
- `results/env.json` — bench-host metadata (node, kernel, cpu).

Run the bench locally:

```bash
cd bench && BENCH_N=200 BENCH_WARMUP=20 node driver.js
```

Recommendation in one line: **Unix socket for HOMELAB-46, file-drop as
automatic fallback, HTTP as transitional operator escape hatch.** See
`memo.md` for the why.
