---
paths:
  - "packages/evals/**"
---

# Eval conventions

Applies to the role eval, holdout questions and the eval runner (technical.md § 13,
concept A-21).

Submission scope decision, 2026-10-18: the original challenge requires a real
answer for each role with accessible query evidence, not a paid API benchmark.
The baseline/development experiment, freeze, first holdout and three-run Web role
comparison are deferred extras, not submission gates. Do not execute them without
a new request. Their implementation is preparation, not a measured quality result.
The submission uses the worked investigation and actual role demonstrations;
analyst-written role views must remain labelled as such. Retain known failed
client probes and state the limits of the recorded evidence.

If the formal experiment is commissioned later, apply these rules:

- Eval ratings come from someone who did not write the playbooks.
- Holdout questions are independently authored and withheld until the eval
  configuration is frozen. Report the first holdout round separately; after
  inspection those questions become regression tests, and a new holdout needs fresh
  questions.
- Compare simple role guidance with full playbooks under equal model, data, tool and
  execution limits, and prevent indirect playbook delivery to the baseline. This
  variant is eval-only; production role guidance remains required.
- Predeclare repeated trials and retain every attempt, including failures. Report
  answer quality, end-to-end duration, calls, tokens and estimated API costs
  separately, with saved run artifacts and pricing provenance.
- Corpus figures still require receipts; eval metadata is not evidence of business
  impact.
- Outperforming the baseline and the optional historical-evidence experiment I-21
  are not acceptance requirements.
