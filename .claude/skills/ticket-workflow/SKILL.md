---
name: ticket-workflow
description: Steps for working a Linear LOG ticket in this repository - status updates, branch naming, commits, pull request, CI, merge and the closing Linear comment. Use when starting, committing, opening a PR for, merging or closing out a LOG-xx ticket, or for work without a ticket (NT).
---

# Ticket and Git workflow

Every ticket follows the same sequence. The prohibitions in AGENTS.md ("Git") apply
throughout.

1. **Start:** read the Linear ticket with its description, acceptance criteria,
   relations, sub-issues and comments. Set its status to `In Progress`.
2. **Branch:** create a branch for the ticket before the first change, from
   `origin/main` after `git fetch` (or from the unmerged branch it builds on, noted
   in the ticket). Name it `log-<number>-<short-english-summary>` in lowercase kebab
   case, for example `log-123-bgl-loader`, with the ID of the ticket or sub-issue
   being worked on. Use this format, not the branch name Linear suggests.
3. **Commit:** one or more focused commits on that branch. Stage files explicitly,
   keep unrelated changes out, keep hooks enabled, and run the relevant checks
   first.
4. **Push and open a pull request:** `git push -u origin <branch>`, then
   `gh pr create` against `main` (or the base branch). Title: the ticket ID and a
   summary under 70 characters, e.g. `LOG-123: BGL loader`. Description: summary of
   changes, checks run with their result, open points, and `Closes LOG-123` (or
   `Part of` for a partial step).
5. **Wait for CI:** follow the run with `gh pr checks --watch`. If a check fails,
   fix the cause in a new commit and push again.
6. **Merge:** once every required check is green and the branch has no conflicts,
   merge with `gh pr merge <number> --merge` (merge commit, as in the existing
   history) and delete the remote branch (`git push origin --delete <branch>`). Do
   not merge with failing or pending checks. A pull request that builds on an
   unmerged branch is merged only after its base.
7. **Update Linear:**
   - Comment with what changed, the branch and commits, the checks run and their
     result, the pull request and its CI result, and any open point or limitation.
   - Keep the description aligned if scope or acceptance criteria changed, and tick
     completed checklist items.
   - Set `Done` only when every acceptance criterion is met and the pull request is
     merged with green CI; otherwise leave it `In Progress` and name what remains.
     Record blockers as `blocked by` relations. Never mark a ticket done on the
     strength of an unrun check.

## Commit messages

English, title and body:

- The title starts with the ticket ID, or `NT:` for work without a ticket (for
  example `LOG-123: Add BGL loader with reject log` or `NT: Fix typo in README`), is
  in the imperative mood and stays under 72 characters.
- The body, after a blank line, explains what changed and why, and names notable
  limits or follow-ups.
