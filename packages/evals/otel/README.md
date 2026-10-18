# OTel role development evidence (LOG-35)

Three predeclared questions exercise Engineer, Team Lead and Manager framing on
real remote OTel logs in the indexed reference window. The script calls the shared
registry, writes query receipts, derives every answer number from returned facts,
and fails unless every submitted claim is verified by `check_claims`.

This is development evidence assembled without a model, not the U16 role eval,
a baseline comparison, a holdout run or an independent rating. Each role starts
with `describe_corpus`, uses full-text search and an aggregation; the Engineer
checks same-component context, the Team Lead checks a service trend, and the
Manager explicitly withholds a priority because episodes and breadth are absent.

Run after loading `pnpm data:setup --with otel,otel_replay`:

```bash
pnpm --filter @workspace/evals otel
```

`results/` stores the English answers, exact tool inputs, receipts and cited
facts. Complete receipts remain in `.data/receipts/`. Each rerun replaces these
artifacts with fresh fact IDs; format the changed JSON with Prettier afterward.
The dataset scope is part_000/part_001, [00:29:14, 00:29:34) UTC on 2025-09-23.
No output claims a full scan of the allowlisted files, causal proof or business
impact. Original log messages are not copied into the tracked answer artifacts.
