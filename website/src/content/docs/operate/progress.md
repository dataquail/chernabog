---
title: Run progress
description: Where chernabog records the phase each item has reached, the rulesets that protect it, and what doctor checks.
---

A flow can record the **phase** an item has reached (`review-asked`, `changes-asked`), so the next run reads where the item is rather than working it out from labels and review counts that anyone can change. Chernabog keeps that record on GitHub, in the repo itself, as protected branches.

## Where it lives

Each item is a branch, `chernabog/threads/<item>` (`chernabog/threads/pr-73`), and each phase it reaches is one commit on it. A commit changes no files: its message carries the record in trailers.

```
chernabog: pr-73 review-asked -> changes-asked

Phase: changes-asked
From: review-asked
By: 0eee9982-bb65-4a62-b603-25023ad948cb
```

`By` is whoever moved the item: a run's id, or a login. Nothing in a thread names the machine that wrote it, since a thread is as public as the repo.

- **A thread starts from a commit with no files**, not from the default branch, so no workflow in `.github/workflows/` runs on its pushes and it never falls behind. That first commit is the item's first phase.
- **Only one writer wins.** A later phase is GitHub's `createCommitOnBranch` with the commit the writer read as `expectedHeadOid`; of two writers that read the same phase, one lands and the other finds the item moved. The first phase is the branch's creation, which only one writer can do.
- **An item's name has no slash.** A ruleset matches `refs/heads/chernabog/threads/*`, and a `*` doesn't cross a `/`.
- **Reads are one GraphQL query** for every thread and its record, and a record is read once for each commit.

Threads show in the repo's branch list. A plain `git fetch` brings them into a clone; to leave them out of yours, run this before the first fetch:

```sh
git config --add remote.origin.fetch '^refs/heads/chernabog/*'
```

## Protecting it

Without rulesets, writes still work, but anyone who can push can rewrite or delete a record. Two branch rulesets on `refs/heads/chernabog/threads/*` stop that:

| Ruleset                     | Rules                                   | Who bypasses                     |
| --------------------------- | --------------------------------------- | -------------------------------- |
| `chernabog-threads-write`   | restrict creations, restrict updates    | the personas team                |
| `chernabog-threads-protect` | restrict deletions, block force pushes  | repository admins                |

Blocking force pushes sits with deletion, not with the write rules: a bypass list exempts its actors from every rule in its ruleset, so the personas would otherwise be able to rewind a thread.

In an organization, as an admin, with `R` the repo and the personas as `alice` and `bob`:

```sh
R=acme/app; ORG=${R%%/*}
TEAM=$(gh api -X POST orgs/$ORG/teams -f name=chernabog-personas -f privacy=closed --jq .id)
for login in alice bob; do
  gh api -X PUT orgs/$ORG/teams/chernabog-personas/memberships/$login -f role=member --silent
done
# GitHub adds a team's creator to it; take yourself out unless you're a persona.
gh api -X DELETE orgs/$ORG/teams/chernabog-personas/memberships/$(gh api user --jq .login) --silent
gh api -X PUT orgs/$ORG/teams/chernabog-personas/repos/$R -f permission=push --silent

ruleset() { # name, rules, bypass actors
  jq -n --arg name "$1" --argjson rules "$2" --argjson bypass "$3" '{name: $name, target: "branch",
    enforcement: "active", conditions: {ref_name: {include: ["refs/heads/chernabog/threads/*"], exclude: []}},
    rules: $rules, bypass_actors: $bypass}' | gh api -X POST repos/$R/rulesets --input - --silent
}
ruleset chernabog-threads-write '[{"type":"creation"},{"type":"update"}]' \
  "[{\"actor_id\":$TEAM,\"actor_type\":\"Team\",\"bypass_mode\":\"always\"}]"
ruleset chernabog-threads-protect '[{"type":"deletion"},{"type":"non_fast_forward"}]' \
  '[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}]'
```

`actor_id` 5 is the repository admin role. A persona that is an organization or repository admin can delete threads too; the design assumes personas aren't admins.

- **A personal repo has no teams.** The write ruleset's bypass list can name the repository admin role, deploy keys and GitHub Apps, so the personas have to be repository admins, which also lets them delete threads.
- **A private repo needs a paid plan for rulesets**: GitHub Team for an organization's, Pro for a person's. On GitHub Free, GitHub refuses them for a private repo, and the record stays unprotected.

## What doctor checks

`chernabog doctor` asks GitHub which rules apply to a thread, as each persona this machine runs the repo as:

- **The repo can't have rulesets**, or **no ruleset holds a rule** (creation, update, deletion, force pushes): a warning, said once for the repo. Writes still work, unprotected.
- **Every rule is there**: whether the persona bypasses every ruleset that holds the write rules. One that doesn't fails the check, since its writes would be refused.

A persona the rulesets refuse doesn't fail a run obscurely either. Its first write stops the run with a setup error, as a reviewer without a seat does: `alice can't record progress: GitHub refused a write to chernabog/threads/* in acme/app (…). Fix: give it write access to acme/app and add it to the team the threads' write ruleset lets bypass`.
