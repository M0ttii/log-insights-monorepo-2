# OpenSSH — Manager

Question: Which observed SSH problems deserve attention first?

## Scope

Dataset `openssh` (one OpenSSH server, host LabSZ, full corpus, data version `dv_02dfa8cc8e16e2a2`), full data span (2017-12-10 to 2018-01-07). Investigation order over the error/alert candidate patterns; error = messages prefixed `error:` or `fatal:` (R-02). The distribution by client IP uses only error lines. This is a technical investigation order, not measured severity or business risk.

## Answer

Priorities (per dataset, investigation order R-08 over 13 patterns [r_39505436.f4] checked, 2,087 log events [r_39505436.f3] in scope):

| #   | pattern                                                                                 | episodes                      | events                          | breadth (client IPs)                        |
| --- | --------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------- | ------------------------------------------- |
| 1   | `7c1bc8c329abeadd` `fatal: Read from socket failed: Connection reset by peer [preauth]` | 112 episodes [r_39505436.f14] | 952 log events [r_39505436.f15] | unknown (not every event carries one, R-08) |

The leading candidate is the SSH pre-auth "connection reset" pattern: it recurs across more episodes than any other candidate and dominates the field on that criterion.

## Why this order

The order is the SQL-returned R-08 investigation order over all candidates checked, not a ranking of the displayed rows. The leading pattern is `clear_priority`: it dominates the other 12 patterns [r_39505436.f5], driven by episodes — it holds the episode lead with 112 episodes [r_39505436.f7]. Breadth (client IPs) is not determinable for this pattern because not every one of its events names an IP, so breadth is reported as unknown, never as a lower bound. Level and status are shown separately, not folded into a score; a rare severe problem can rank lower, and there is no composite risk score.

## Decision needed

Assign the leading candidate pattern to the fictional `Access Services` team (owner of `sshd`) for a review of repeated pre-auth connection resets. Investigation only — no production change, ticket or paging.

As supporting context, error lines by client IP span 15 groups [r_866b7f60.f1] over 2,087 log events [r_866b7f60.f25]: the largest group is the `null` category — 967 log events [r_866b7f60.f2] name no parseable client IP — and the busiest single client IP is `103.99.0.122` with 930 log events [r_866b7f60.f4].

## Missing information

Business impact unknown. Whether the repeated resets reflect brute-force scanning, network faults or client misconfiguration is not established by these counts. The leader's client-IP breadth is unknown. Causal origin is not established. Ownership is fictional.

## Verification

check_claims receipt `r_4ea5dbcb`: 10 claims checked · 0 mismatch · 0 unresolved.
