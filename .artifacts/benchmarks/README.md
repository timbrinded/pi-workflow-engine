# Benchmark artifacts

This directory is ignored by git by default and is used for local no-LLM benchmark JSON written with `--out`.

Examples:

```bash
bun run bench:concurrency -- --items 200 --concurrency 8 --json --out
bun run bench:discovery -- --iterations 3 --json --out
bun run bench:ui -- --agents 1000 --lane-items 1000 --json --out
```

Benchmark timings are advisory and machine-dependent. Use them to compare before/after changes on the same machine; do not treat them as portable pass/fail thresholds.
