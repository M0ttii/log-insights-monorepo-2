# LOG-41 code review

## Actionable Findings

The completed built-in Codex review against `91501f7` found four P2 issues:

1. IP extraction could count C++ identifiers as IPv6, truncate mapped IPv6 and accept invalid group counts.
2. Temporal-analysis facts lacked their selected pattern identifiers, so claim checking could not verify pattern assignment.
3. An unseen query could use a different provider/model revision from the saved event embeddings while reporting the original provenance.
4. A surviving filesystem manifest prevented rebuilding a missing database representation after a volume reset.

All four findings were assigned bounded fixes and regression checks. No finding remains as an accepted residual release risk.

## Coverage

The `ce-code-review` quick path used the built-in `codex review --base 91501f7` command, completed successfully. It examined the actual tracked/staged feature diff, source, contracts and tests. Its sandbox prevented real database connections; the parent separately ran the native integration and independent full-corpus references with local network access.

Three `ce-simplify-code` reviewers examined reuse, code quality and efficiency. Applied: canonical digest reuse, an explicit entity-source map, separate optional fact-specification arrays. The proposed parallel provider calls were left serial to preserve request ordering and failure-side costs.

## Verdict

All four findings were fixed before merge:

- Native `TRY_CAST(... AS INET)` validates complete IP tokens; real-engine fixtures cover false C++ suffixes, mapped IPv6, invalid groups and original spelling.
- Pattern/type identity is required in numerical fact groups; correct claims verify and wrong or missing groups mismatch through the real registry.
- Runtime retrieval accepts exact vectors saved in the snapshot. Unseen queries require a new offline build/import, preventing unverifiable provider/model aliases from being mixed with old embeddings.
- A per-snapshot build lock, immutable saved import and owned-object recovery restore a lost database index without overwriting a healthy concurrent build.

Focused regressions and the parent checks verify the fixes. Provider-backed quality, genuine Claude role runs and OTel semantic snapshots remain ticket acceptance limits, separately documented; they are not hidden code-review findings.

## Additional applicability regression

The independent verifier exercised IP/path distributions through the existing
OTel direct, indexed and replay relations and found polluted bound-parameter
lists (`08P01`). The count tool now snapshots only relation-owned bindings before
adding count/filter/ranking parameters. Six real regression cases failed before
the change and passed afterwards. Source lint and analytics typecheck passed.
