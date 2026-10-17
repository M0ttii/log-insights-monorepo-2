---
paths:
  - "packages/evals/**"
---

# Eval conventions

Applies to the role eval, holdout questions and the eval runner (technical.md § 13,
concept A-21).

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
