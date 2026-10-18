# LOG-41 research evidence

The SQL/retrieval mechanics pass against local SereneDB 26.10.1. Provider-backed acceptance remains open: there is no configured OpenAI-compatible SereneDB secret and `ANTHROPIC_API_KEY` is absent. No semantic quality advantage or summary usefulness is claimed.

- `gate.json`: actual G14 results. Combined text/vector inverted indexes, filtered cosine retrieval and RRF work. `ai_embed` and `ai_summarize_agg` exist; an absent named secret produces `42704`. With zero configured provider secrets, default `ai_summarize_agg` fails with `22023: ai_summarize_agg: no secret given`. No external provider call was made.
- `questions.json` and `comparison.json`: the fixed four questions across lexical/semantic/hybrid, with failure cases and elapsed time. The eight semantic/hybrid attempts fail explicitly because no pinned representation was supplied; they never fall back to lexical. Embedding build cost is unknown, not zero. These are diagnostic runs, not a relevance benchmark.
- `verification.json` and `receipts/`: six real full-corpus analytical tool chains (entities, contributions, periodicity, cooccurrence, strict order, outliers). Each cites a genuine numeric fact and submits both its correct value and a deliberately altered value to `check_claims`: one verifies, one mismatches, none are unresolved. Intended roles are recorded as context only; these are deterministic tool calls, not model-generated role answers.
- `role-attempt.json`: the actual CLI failure caused by the missing Anthropic key. Genuine role model runs for each new mode, provider-backed semantic/hybrid evaluation and demonstrated summary usefulness are still required before this acceptance scope is complete.

Independent tests were authored by a different agent from the implementers:

- `packages/analytics/tests/integration/log-41-retrieval.test.ts`: five cases; hand-authored orthogonal vectors establish cosine/RRF expectations, filtering before top-k, unknown wording, empty scopes, explicit missing embeddings, phrase/fuzzy preservation and immutable reruns. Synthetic vectors establish mechanics only.
- `packages/analytics/tests/integration/log-41-analytics.test.ts`: five cases; common/rare entities and duplicate IDs, original IP/path values, small/empty periodicity populations, a scheduled temporal association with a discriminating control/reversed order, and insufficient/full latency baselines with individual case checks.
- `packages/analytics/tests/golden/log-41-research.test.ts`: nine full-corpus cases; independent original-table SQL validates eligible dictionary facets including null/rest groups, opt-in signed contribution reconciliation, unavailable references, raw timestamp gap statistics, a complete union of structured/raw request entities, cooccurrence/order with control populations and the complete measured-duration outlier baseline.
- `packages/corpus/tests/integration/log-41-research.test.ts`: actual engine G14 capability checks.
- `apps/mcp/src/log-41.test.ts`: six tests confirm the shared eight-tool schemas and actionable validation failures before database access.

All original 26 focused tests passed locally; two additional real-engine IP regression cases were added during review. The parent workflow runs the repository-wide checks separately. Initial local evidence used Node 25.3.0; final authoritative checks use the repository's pinned Node 24.

Regenerate the tool chains and comparison from `packages/analytics`:

```sh
node --env-file=../../.env --import tsx ../../submission/log-41/verify.ts
node --env-file=../../.env --import tsx ../../submission/log-41/compare.ts
# Optional existing immutable snapshot ID; missing query vectors may require a provider:
node --env-file=../../.env --import tsx ../../submission/log-41/compare.ts <snapshot-id>
```

Run `pnpm gate G14` for the native capability probe. No loader/reset is part of these evidence runners.

Current documentation was checked through Context7 `/serenedb/serenedb`: [AI functions](https://github.com/serenedb/serenedb/blob/main/docs/sql/functions/ai.md), [vector indexes](https://github.com/serenedb/serenedb/blob/main/docs/sql/indexes/inverted/vector-search.md), [RRF](https://github.com/serenedb/serenedb/blob/main/docs/cookbook/search/reciprocal-rank-fusion.md), and [secret metadata](https://github.com/serenedb/serenedb/blob/main/docs/sql/functions/metadata.md). Only the configured-secret count was inspected; no secret content is included.

Review findings and their fixes are recorded in [review.md](review.md). IP extraction
uses SereneDB's native `INET` parser over complete tokens; IPv6 zone suffixes are
currently unsupported. Runtime retrieval accepts only exact query vectors saved
in a snapshot, because the provider does not attest an immutable model revision.
Unseen queries require a new offline build/import. Saved `.import.json` vectors
allow rebuilding lost database representations.

## Parent validation

Authoritative local checks use Node 24.22.0: `pnpm check` passed after review fixes (1,022 unit tests),
and `pnpm build` passed. The parent independently reran all 29 focused native
checks: twelve analytics cases, nine full-corpus Golden cases, six MCP
cases, G14 and the snapshot restore regression.

The additional existing search/count/digest regression run passed 131 of 132
checks. Its sole failure was the unchanged `describe` digest: the local samples
manifest records loader `1.1.0`, while the saved reference and current loader are
`1.2.0`. The independent verifier compared the complete objects and found only
`/versions/loader_version` different. Existing compare output, fact and digest
checks all pass. Shared samples were left untouched; fresh-loader CI validates
the complete suite. No baseline or assertion was weakened.

Simplification reused the canonical result digest, made entity source selection
explicit and separated optional fact specifications. Parallel provider calls
were not introduced: changing their order and failure-side request count would
change behavior, and serial calls bound provider load.

After integrating the latest `main` (LOG-55), `pnpm check` passed again with
1,039 unit tests. Dictionary facets additionally require exactly the measured
BGL/OpenStack loaded scope; single-dataset or extension-loaded scopes keep the
existing path. Focused facet/count regressions and analytics typecheck pass.
