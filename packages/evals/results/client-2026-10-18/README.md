# MCP client development probes, 2026-10-18

These are retained development probes for LOG-38/LOG-39, not a passed U16
experiment, baseline comparison, independent rubric score or first holdout.
The actual answers are preserved, including their opening text. Failed attempts
remain failed; the successful clarification is a routing control only.

| Probe | Configuration | Result |
| --- | --- | --- |
| Desktop ambiguous role, before | Opus 5.5 Mittel; no prompt; guidance 1.0.7 | Asked for perspective but introduced uncited corpus dates/counts and a numerical option limit. |
| Desktop ambiguous role, after | Same visible model/effort; no prompt; guidance 1.0.8 | Asked for Engineer, Team Lead or Manager without optional analytical quantities. Routing control passed. |
| Desktop Engineer | Actual local Engineer MCP prompt; Opus 5.5 Mittel; guidance 1.0.8 | Failed whole-answer number coverage and causal wording, despite 27 submitted claims passing. |
| Claude Code Engineer, M1 before hint | Claude Code 2.1.302, claude-opus-5-5, medium; actual prompts/get; six guarded M1 tools; guidance 1.0.8 | Twelve calls, no M1 violations; failed numerical coverage and causal wording. Required corpus result exceeded the client's inline limit. |
| Claude Code Engineer, M1 after hint | Same question/model/effort/guidance, new attempt and receipts; only result-size hint changed | Full corpus JSON delivered inline; thirteen calls, no M1 violations. Answer still fails numerical coverage and causal interpretation. |

The clarification files preserve visible accessibility text and chat URLs. The
Engineer answer was copied with the app's original Copy action into TextEdit and
saved as UTF-8 without editing. Desktop exposes its model label, not a served API
model ID, token usage, exact provider duration or API cost. None is invented here.
The Code answer comes unchanged from its terminal result. Its CLI cost estimate
is not evidence of API spending through the subscription account.

Audit JSON records input, receipt IDs/hashes, data version, actual claim checks,
canonical whole-answer findings and separate manual semantic findings. Complete
original receipts and Code events remain in the isolated checkout under
`.data/log39-acceptance-20261018/`; this report is a compact audit index, not a
complete receipt export. The data version is `dv_5663ee75e955ec1d`; source base is
`82f058537e2840f2234dd4bac73dcf952d1897d7` plus the recorded guidance edit.

The canonical number scanner excludes code spans. Manual inspection additionally
found uncited backticked trend dates in the Desktop answer. A green subset of
`check_claims` neither covers every answer occurrence nor verifies causal prose.
The Engineer openings overstate causal origin while later paragraphs qualify it.
Later caveats do not repair the opening. The remaining role/client matrix is open.

Claude Code was signed in through the existing claude.ai subscription. Its first
launch request was rejected before process start by automatic approval review.
After the BGL file checksum proved the exact public catalog source and explicit
BGL-only/context/receipt guards narrowed the request, a second review approved
the first actual Code model run. A separately approved targeted after-hint probe
uses a new directory and preserves that first failure. No failed model attempt
was replaced or hidden.
No API key, private holdout question, paid U16 experiment, freeze or release was used.

The Code result-size diagnosis led to a narrowly scoped MCP catalog hint for
`describe_corpus`, verified over the actual SDK transport. It requests a larger
inline limit for supporting clients. The separate after-hint Code probe received
the complete 116,402-character corpus JSON, including answer_guidance, inline
without a token-limit environment override. Its answer still failed. The first
Code probe remains unchanged; neither result establishes general client conformance. Guidance 1.0.8 changes only the ambiguous-role
clarification; these probes do not establish a general quality improvement.

## S-12 normalized-input parity

A separate model-free probe called the production MCP server over SDK stdio and
then the actual Web `POST /api/tools/count_events` route on loopback. Both used
the identical BGL text filter, June window, rack grouping and `top_n: 3`.
The [comparison](s12/comparison.json) and both complete original receipts are
saved here. Normalized input, signature, data/tool version, result digest and
analytical data agree. Distinct receipt IDs, clients and durations are expected.
This establishes this S-12 tool-path case; it does not establish role-answer
quality, Web streaming, or the remaining client matrix. No model was called.
