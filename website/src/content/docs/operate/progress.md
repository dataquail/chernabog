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

## The review loop's phases

The review loop runs on these records: `implement`, `review`, `re-review`, `address-review` and `resolve-conflicts`, whether as the recipes in TypeScript or as [flow documents](/chernabog/flows/documents/#phases).

| Phase                | Recorded by                                                                                       | Read by                                   |
| -------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `review-asked`       | a hand-off (`issue.handOff`, `issue.handOffAdopted`, `hybrid.handOff`)                            | `review`                                  |
| `draft`              | a hand-off of a draft                                                                             | `review`, once a person asks for a review |
| `changes-asked`      | a review that requests changes (`review.round`, `review.recheck`)                                  | `address-review`                          |
| `approved`           | a review that approves                                                                            | for status                                |
| `review-asked-again` | asking again (`review.askAgain`, `conflict.askApproverAgain`, an epic layer's refresh)            | `re-review`                               |
| `merge-held`         | a merge held while the base is red                                                                | for status                                |
| `ready-for-person`   | `pr.readyForPerson`                                                                               | `review`, once a person asks for a review |

An issue records `handed-off` when its pull request is, `asked-questions` when the agent asks, and `awaiting-ready` while a run waits on an adopted draft.

- **Facts and intent stay on GitHub.** Whether a pull request is open, its head, CI, who is asked to review and the reviews themselves are read from GitHub, as are `auto:needs-human` and `auto:ship`. A label or an assignee that changes, or another comment or review, doesn't move an item's phase. A run's work is keyed by the record it reads, `pr-7-changes-asked-1a2b3c4`, so a new record is new work and nothing else is.
- **A closed or merged pull request ends its record**, whatever it says: no flow picks it up.
- **A fact no run was there for moves the record on.** A person's review that asks for changes on the head moves a pull request to `changes-asked`, and a person asking a persona to review again moves one at `changes-asked` or `approved` to `review-asked-again`. So does a review asked of a persona that has reviewed a pull request recorded `review-asked`, such as one adopted after its review. The source that would pick the pull request up writes it, as `observer:<source>`.
- **A record GitHub disagrees with is shown, not skipped.** When `address-review` finds `changes-asked` but the head has moved since without the reviewer being asked again, or the latest review approves, the item is held, and `chernabog status` says why. Fix GitHub, by asking for the review again, say, or move on and let the next fact move the record.
- **A pull request from before phases**, with no record, is read as it was before: from review counts, keyed `pr-7-changes-2` and `pr-7-review-2`. It records phases from its next handoff on. This fallback goes in a later release.

### Upgrading a repo's own flows

The phases are recorded and read inside the SDK's functions, so a recipe you haven't edited, and every flow document, gets them without a change. What a repo with its own flows changes:

- **A copied recipe you edited** keeps its own trigger, which still works things out from review counts. It still records phases, since `Review.round`, `Review.askAgain`, `Implement.handOff` and the rest do, but it doesn't read them, so a label or a review count can still move its work. `chernabog recipes update` merges the new triggers in: `review` calls `Review.requestedFirst`, `re-review` calls `Review.requestedAgain`, `address-review` calls `Review.changesToAddress`, and `resolve-conflicts` calls `Review.askApproverAgain`.
- **A flow of your own in TypeScript** that hands off, reviews or asks again through the SDK records phases already. One whose trigger reads `Review.reviewRequests` gets each pull request's record beside its review count; use the functions above to find work by phase.
- **A document** needs no change. Where a stage of your own does what a recording block would, such as posting the review itself, follow it with `progress.advance` so the flow that reads that phase finds the item; a review your stage posts on GitHub is reconciled anyway.

## Announcing each advance

A thread's commits start no workflow, so after each phase an item advances to, the writer sends a [`repository_dispatch`](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event) to the repo: event type `chernabog-phase`, payload `{"item": "pr-73", "from": "review-asked", "to": "changes-asked"}` (`from` is `null` for an item's first phase). It starts the default branch's workflows that listen for it, so a repo running its flows in CI starts the item's next step on a runner, whoever advanced the phase, a laptop's daemon included.

- **Only an advance that lands is announced.** A writer that loses the race sends nothing. A retried advance that finds its own write already there announces it again: an extra event costs one plan job, and a lost one leaves the item for the sweep.
- **A failed announcement fails nothing.** The phase is recorded, the run's log says the announcement didn't go, and the CI sweep picks the item up.
- **It is sent as the persona**, with its token, which needs write access to the repo (Contents: write on a fine-grained token), as writing the thread already does.
- **`announcePhases: false`** in `.chernabog/config.yaml` turns it off, for a repo that doesn't run flows in CI.

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
