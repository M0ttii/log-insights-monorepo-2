# U26 (LOG-40) acceptance evidence — five new Loghub sources

Acceptance for U26 requires, for each of the five new Loghub sources, **at
least one real role question with stored tool calls, receipts and fact
checking**. This folder is that evidence.

## Method

- **No model is involved.** No `ANTHROPIC_API_KEY` is configured, so the agent
  runner is not used. Instead `run.ts` acts as the analyst itself: it calls the
  real registered tools through the shared registry
  (`@workspace/analytics/registry`) with client `eval`, the same pipeline the
  MCP server and the web chat use. The tool sequences and the role framing
  follow the playbooks in `packages/agent/src/playbooks` (common + the role
  files).
- For every dataset the script runs `describe_corpus` once, then one fixed,
  **predeclared** role question:

  | dataset     | role      | question                                                                                                           |
  | ----------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
  | `hdfs`      | Team Lead | Which recurring WARN patterns does the Storage Platform team have, and how are they distributed over the two days? |
  | `openssh`   | Manager   | Which observed SSH problems deserve attention first?                                                               |
  | `apache`    | Engineer  | What happened around the first mod_jk error-state event?                                                           |
  | `linux`     | Team Lead | Which programs log most and recur, and who owns them?                                                              |
  | `zookeeper` | Engineer  | What precedes the shutdown-exception errors?                                                                       |

- Every tool run writes a receipt JSON to `.data/receipts/` (gitignored) and
  returns typed facts with fact IDs. The script **cites facts only from those
  receipts**; the numbers printed in each `results/<dataset>.md` answer are
  rendered from the very facts that were returned, so prose and receipts cannot
  drift.
- For each answer the script submits **all** cited numbers through
  `check_claims` (again through the registry) and records the check's receipt ID
  and its summary line. The script fails loudly if any claim is not verified, so
  a committed result means every cited number resolved to its fact with the
  stated metric and group (`N claims checked · 0 mismatch · 0 unresolved`).

## Output

Per dataset in `results/`:

- `<dataset>.json` — the ordered tool calls (step, tool, validated input,
  receipt ID, a short data summary, and the facts actually cited), plus the
  `check_claims` receipt ID, summary line and the submitted claims.
- `<dataset>.md` — a concise English answer in the shared frame
  (Scope · Answer · role core · Unknown · Verification), citing fact IDs.

Receipts themselves live in `.data/receipts/` (gitignored); the JSON files carry
the receipt IDs that point to them. Receipt IDs change on each run (they are
random), so the IDs in committed files reflect the run that produced them.

## Rerun

Requires the full corpus with all seven datasets loaded in the database named by
`SERENEDB_DATABASE` (this worktree: `load_manifest.source = 'corpus'`,
`data_version = dv_02dfa8cc8e16e2a2`). The script never loads or writes corpus
data; it only reads and writes receipts.

```bash
pnpm --filter @workspace/evals u26
```

A rerun overwrites the files with fresh receipt IDs. The written JSON uses
`JSON.stringify` indentation, which differs from Prettier only in collapsing
short single-element arrays, so run `pnpm format` (or
`prettier --write packages/evals/u26/results`) once after a rerun to keep
`pnpm check` green.

## Limitations

- This is **development evidence, not the U16 role eval**: no model, no
  baseline comparison, no independent rater, no holdout. It demonstrates that
  the tools, facts and `check_claims` work end to end on each new source and
  that an honest role answer can be assembled and fully fact-checked.
- Answers stay within the domain invariants: precursors are temporal
  observations, never causes; ownership is fictional and labelled as such;
  business impact is unknown; HDFS carries no error (WARN is a warning) and
  Linux has no error definition at all (R-02).
- Counting units are kept apart (R-01); frequencies come from aggregation
  tools, never from search hits. Where a value is `null` (e.g. the leading
  OpenSSH pattern's client-IP breadth, or error lines that name no client IP),
  it is reported as unknown, never as zero or a lower bound.
- `check_claims` verifies numbers, metrics and groups only — never
  explanations, hypotheses or causal statements.
