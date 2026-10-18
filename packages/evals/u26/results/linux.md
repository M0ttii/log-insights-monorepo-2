# Linux — Team Lead

Question: Which programs log most and recur, and who owns them?

## Scope

Dataset `linux` (/var/log/messages of one host `combo`, full corpus, data version `dv_02dfa8cc8e16e2a2`), full data span (2005-06-09 to 2006-02-28). Grouped by fictional owning team and component (program); patterns ranked by episodes; a weekly trend split by component. Linux has no error definition (R-02), so no line is classified as an error here. Ownership is fictional.

## Recurring patterns and distribution

Log events total 25,547 log events [r_14047588.f25] across 73 groups [r_14047588.f1] of team and component (program). The two busiest programs:

| team               | component (program) | events                            |
| ------------------ | ------------------- | --------------------------------- |
| `Compute Platform` | `kernel`            | 13,670 log events [r_14047588.f2] |
| `Access Services`  | `sshd(pam_unix)`    | 4,996 log events [r_14047588.f4]  |

Patterns in scope: 765 patterns [r_af8fc30d.f4] over 25,547 log events [r_af8fc30d.f3]. The leading pattern by episodes (`05d9fad193311a1f` `session closed for user <USER>`) has 270 episodes [r_af8fc30d.f8] over 472 log events [r_af8fc30d.f9]. The weekly trend covers 25,547 log events [r_657f0331.f286] over the span, split by component.

## Recurring vs. one-off

The leading pattern recurs across many episodes, not a single burst; the weekly trend spreads events across weeks rather than one isolated week (buckets outside the span are not zero).

## Investigate first

By volume and recurrence, `kernel` (owned by the fictional `Compute Platform`) is the natural first review. Propose a team review of its most recurrent pattern. Investigation proposal only — no production change.

## Unknown

Linux carries no error level, so "most logging" is not "most failing"; severity and business impact are unknown. Ownership is fictional. A line with a `null` component is its own category and not attributed to a team.

## Verification

check_claims receipt `r_7fb7b96f`: 9 claims checked · 0 mismatch · 0 unresolved.
