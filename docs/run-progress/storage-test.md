# Run progress: protected branches as the storage

The storage test for the run-progress epic (#360), from #361. It answers what
the design depends on before anything is built, from what was observed on
GitHub on 2026-11-09.

## Verdict

**Keep protected branches, but the ruleset half is still unproven.** Everything
that doesn't need a ruleset works and was observed: an advance is atomic with
exactly one winner, a commit needs no file change, the first phase can be
written atomically, reads are cheap, and no workflow runs. The questions that
need a ruleset (1, 5 and 6) couldn't be run: the test repo is private, the
`dataquail` organization is on GitHub Free, and GitHub refused to create a
ruleset on it (question 10). A public test repo wasn't created in this run, so a
person has to run [the ruleset script](#the-ruleset-script-to-run-on-a-public-repo)
on one. #363 doesn't depend on those answers; #364 does.

Four observations change the design. They're listed under
[Changes to the design](#changes-to-the-design).

## Setup

- `dataquail/chernabog-phase-test`, **private**, created with `auto_init`, on
  the organization's Free plan.
- Two tokens from `gh auth`, both OAuth (`gho_`) with `repo`, `workflow` and
  `read:org`: `zacharyweidenbach` and the persona `data-quail`. Both are
  organization admins, which matters for question 1: a ruleset doesn't exempt
  admins unless its bypass list names them.
- Thread branches under `refs/heads/chernabog/threads/`.

## Answers

### 1. Do rulesets apply to API writes?

**Not observed.** Creating the ruleset on the private repo returned:

```
POST /repos/dataquail/chernabog-phase-test/rulesets
403 {"message":"Upgrade to GitHub Pro or make this repository public to enable this feature."}
```

GitHub's docs say rulesets apply to every push, and `createCommitOnBranch`'s
reference says it respects branch protection, but whether `POST`, `PATCH` and
`DELETE /git/refs` are checked against a ruleset's creation, update and
deletion rules is exactly what needs observing. The script below records each
call's status for a token with bypass and one without.

### 2. Does `createCommitOnBranch` accept a commit with no file changes?

**Yes.** `fileChanges: {}` made a commit whose tree is its parent's:

```
createCommitOnBranch(input: {branch: …, expectedHeadOid: "fa7baf8…", message: {headline: "phase: a"}, fileChanges: {}})
→ 200, commit d7bec29…, tree 4b825dc… (the parent's), parent fa7baf8…
  signature {isValid: true, signer: web-flow}, author zacharyweidenbach
```

So the phase can live in the commit's headline, with no file to rewrite. The
commit is signed by GitHub and authored by the token's owner, as the epic
expects.

### 3. How is an item's first phase written atomically?

**`POST /git/refs` gives "only one writer wins".** Creating a ref that exists
returns `422 {"message":"Reference already exists"}`. In five two-way races,
`zacharyweidenbach` and `data-quail` each sent `POST /git/refs` for the same
new branch at once, pointing at different commits: every time exactly one got
`201` and the other `422`, and the branch pointed at the winner's commit.

So the first phase is two steps, each atomic: create the ref (lost race is a
`422`), then `createCommitOnBranch` with the ref's commit as
`expectedHeadOid`. Or the first phase is the root commit itself (below), which
makes it one step.

**Start from a root commit with an empty tree, not the default branch's tip.**

- **Making it.** `POST /git/trees` with `tree: []` is refused
  (`422 Invalid tree info`), but `POST /git/commits` accepts the well-known
  empty tree, `4b825dc642cb6eb9a060e54bf8d69288fbee4904`, with no parents. The
  root commit can carry the first phase in its message, and the same root
  commit can be reused for every item. A commit made through
  `POST /git/commits` is unsigned (`verification.reason: "unsigned"`), unlike
  one from `createCommitOnBranch`; if every phase must be signed, the root
  carries no phase and the first phase is a `createCommitOnBranch` on it.
- **Actions.** A push workflow is read from the pushed commit's tree. A branch
  from the default branch's tip carries every workflow; one from the empty
  root carries none. See question 7.
- **The UI and the API.** A branch from the root has no common ancestor with
  `main`: `GET /compare/main...<branch>` returns
  `404 "No common ancestor between main and chernabog/threads/wf-root."`, and
  the branch page shows only its own phase commits. A branch from the tip
  compares as `ahead_by: 3, behind_by: 0, files: 0`, and it falls behind `main`
  as `main` moves on. Neither had a pull request associated with it. The
  "Compare & pull request" banner wasn't checked in a browser.
- **A fetch.** A root branch costs its own commits and nothing else: fetching
  70 branches, 60 of them pointing at one root commit and two with phase
  commits, added 4 loose objects and no pack data to a clone that had `main`.
  A branch from the tip shares `main`'s history, so its cost is also small, but
  it pins whatever `main` was when it was created.

### 4. What does a lost race return?

**Two shapes, both HTTP 200, and the adapter must map both.**

- **A stale `expectedHeadOid`**, sent after someone else's advance landed:

  ```json
  {
    "data": { "createCommitOnBranch": null },
    "errors": [
      {
        "type": "STALE_DATA",
        "message": "Expected branch to point to \"fa7baf8…\" but it did not.  Pull and try again."
      }
    ]
  }
  ```

  That confirms the community gist.

- **A true race**, two advances sent at the same moment with the same
  `expectedHeadOid`. In nine two-way races, one won and the loser got
  `FORBIDDEN`, never `STALE_DATA`:

  ```json
  {
    "data": { "createCommitOnBranch": null },
    "errors": [{ "type": "FORBIDDEN", "message": "is at 7e84cb1… but expected 83b6417…" }]
  }
  ```

  Both passed the up-front check, and the ref's compare-and-swap refused the
  second. A ruleset refusal is very likely `FORBIDDEN` too, so the type alone
  can't tell a lost race from a lack of permission.

Every race had exactly one winner, and the branch's history stayed a line.
`gh api` exits non-zero on these, since the response has `errors`.

### 5. Do bypass lists layer?

**Not observed**, for the reason in question 1. GitHub documents that rules
from every ruleset that targets a ref are aggregated and the most restrictive
applies, with each ruleset's bypass list exempting its own rules only. The
script tests it: the persona is on the creation-and-update ruleset's list but
not the deletion one's, and the other account the reverse.

### 6. Can a persona be granted bypass?

**Not observed.** A persona's token from `gh auth` is an OAuth token for a user
(`gho_`), so a team in a bypass list should cover it as it covers the person;
the script checks it with `data-quail`. Two things from this run's setup bear
on it:

- `data-quail` is an organization admin. If the deletion ruleset's bypass list
  is "Organization admin", a persona that is one can delete threads. The
  design's "deleting: only admins" assumes personas aren't admins.
- On a personal account's repo there are no teams. Its bypass list can name
  the repository admin role, deploy keys and GitHub Apps; a persona with write
  access but not admin can't be listed. The choices there are: no bypass for
  creation and update (so personas can't write, and nothing works), the
  persona as a repo admin (which also lets it delete), or the custom-refs
  fallback. #364's `doctor` check should say so for a personal repo.

### 7. Do the writes trigger Actions?

**Yes, from the tip; no, from the empty root.** The test repo's `main` had a
workflow on `push:` and `create:` with no branch filter. The runs:

| Write                                                      | Branch started from | Run                 |
| ---------------------------------------------------------- | ------------------- | ------------------- |
| `POST /git/refs`                                           | `main`'s tip        | `push` and `create` |
| `createCommitOnBranch`, headline `phase: review-requested` | `main`'s tip        | `push`              |
| `createCommitOnBranch`, headline `… [skip ci]`             | `main`'s tip        | none                |
| `createCommitOnBranch`, body `skip-checks: true`           | `main`'s tip        | `push`              |
| `POST /git/refs`, then `createCommitOnBranch`              | empty root          | none                |
| 60 × `POST /git/refs`                                      | empty root          | none                |

`[skip ci]` works for commits made this way, but it can't stop the `create`
event of a new ref, and `skip-checks: true` is for checks, not Actions. A
branch whose tree has no `.github/workflows` runs nothing at all, which settles
it: start from the empty root.

### 8. Are there other side effects?

- **The branch list.** Every thread is a branch: the test repo's
  `GET /branches` returned 70. They show in the UI's branch list.
- **The activity log.** `GET /repos/{repo}/activity` recorded every write: 70
  `branch_creation` and 15 `push` entries. The public events feed
  (`GET /repos/{repo}/events`) was empty for the private repo during the run.
- **Notifications.** Not checked: the tokens lack the `notifications` scope.
  Pushes to a branch don't notify watchers in GitHub's model; a public repo's
  watchers would see them in their feed.
- **`git fetch`.** A plain `git fetch origin` brought in every thread (70
  remote-tracking branches). The daemon mostly fetches a named branch, but
  `checkout` in `src/modules/runs/infrastructure/runtime/sdk-live.ts` falls back
  to a plain `git fetch origin`, and a person's own clone fetches everything. A
  negative refspec leaves them out: with
  `git config --add remote.origin.fetch '^refs/heads/chernabog/*'` before the
  first fetch, a fresh repo got only `main` (git 2.54; negative refspecs need
  2.29). Added to a clone that already has them, `git fetch --prune` doesn't
  remove the existing ones, since prune only touches refs the refspec matches.

### 9. Reading many items

With 69 thread branches:

| Read                                                                                                                         | Gives                       | Cost                                  |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------- |
| `git ls-remote origin 'refs/heads/chernabog/threads/*'`                                                                      | every tip                   | 0.7 s, no REST quota                  |
| `GET /git/matching-refs/heads/chernabog/threads/`                                                                            | every tip                   | one REST call, all 69 in one response |
| GraphQL `refs(refPrefix: "refs/heads/chernabog/threads/", first: 100)` with `target { oid … on Commit { messageHeadline } }` | every tip **and its phase** | one query, cost 1, 100 a page         |
| GraphQL `object(oid:)` aliases                                                                                               | the phase of chosen tips    | one query, cost 1                     |

With the phase in the commit's headline, the GraphQL `refs` query gets every
item's tip and phase in one call, so there's no second step. A poller that
wants to skip unchanged items keeps the last oid it saw for each and compares.

### 10. Plans

- **Private repos in an organization on GitHub Free: no rulesets.** Observed:
  the 403 in question 1. The message names GitHub Pro, which is a personal
  plan; for an organization it's Team or above.
- **Public repos on Free:** documented as supported, not observed here.
- **Private repos on Team, Enterprise and personal Pro:** documented as
  supported, not observed.
- Organization-wide rulesets need Enterprise; this design uses
  repository rulesets.

## Changes to the design

1. **A lost race has two shapes.** The adapter maps `STALE_DATA`, and
   `FORBIDDEN` whose message reads "is at … but expected …", to the port's
   lost-race error. Since a ruleset refusal may also be `FORBIDDEN`, the robust
   rule is: on any error, read the ref again, and if it isn't at
   `expectedHeadOid`, someone else advanced it. Only otherwise is it a
   permission error. #363's contract tests should cover both.
2. **Threads start from one root commit with the empty tree.** No workflow
   runs, a fetch costs almost nothing, and the branch never falls behind
   `main`. Phase commits are `createCommitOnBranch` with `fileChanges: {}` and
   the phase in the headline; no file is stored.
3. **Reading is one GraphQL query.** The `refs` query with `messageHeadline`
   replaces "list tips, then read the phase of those that changed".
4. **Private repos on Free can't use this at all.** #364's `doctor` check has
   to detect it (creating or listing rulesets returns 403) and say what to do:
   upgrade, make the repo public, or use the custom-refs fallback. Personal
   repos have no teams, so the same check applies to them.
5. **Checkouts should leave the threads out**, with the negative refspec
   above, set when the daemon creates a checkout.
6. **Blocking force pushes goes in the deletion ruleset.** A bypass list
   exempts its actors from every rule in the ruleset, so if "block force
   pushes" sits with creation and update, as "two rulesets" suggests, the
   personas team can force-push. It belongs with deletion, or in a third
   ruleset with no bypass at all. The deletion ruleset's "admins only"
   exemption covers deletion and force pushes, but `update` sits in the other
   ruleset, so an admin who isn't on the personas list still can't rewind a
   thread: only an actor on both bypass lists can force-push. This follows
   from GitHub's documented model; the script checks it.

## The ruleset script, to run on a public repo

Questions 1, 5 and 6 are open until this runs. It needs a **public** throwaway
repo in `dataquail`, the `data-quail` persona in `gh auth`, and an admin token
for setup (the active `gh` account). It creates two teams, so the two accounts
are each on one bypass list: `phase-test-personas` (with `data-quail`) on the
creation-and-update ruleset, and `phase-test-deleters` (with the admin) on the
deletion ruleset. GitHub adds the creator of a team to it, so the script
removes the admin from the personas team.

```sh
set -u
R=dataquail/chernabog-phase-test        # public
ADMIN=$(gh api user --jq .login)
DQ=$(env -u GH_TOKEN gh auth token --user data-quail)
T=refs/heads/chernabog/threads

team() { gh api -X POST orgs/dataquail/teams -f name="$1" -f privacy=closed --jq .id; }
P=$(team phase-test-personas); D=$(team phase-test-deleters)
gh api -X PUT orgs/dataquail/teams/phase-test-personas/memberships/data-quail -f role=member --silent
gh api -X DELETE orgs/dataquail/teams/phase-test-personas/memberships/$ADMIN --silent
for t in phase-test-personas phase-test-deleters; do
  gh api -X PUT orgs/dataquail/teams/$t/repos/$R -f permission=push --silent
done

ROOT=$(gh api -X POST repos/$R/git/commits -f message=root -f tree=4b825dc642cb6eb9a060e54bf8d69288fbee4904 --jq .sha)
CHILD=$(gh api -X POST repos/$R/git/commits -f message=child -f tree=4b825dc642cb6eb9a060e54bf8d69288fbee4904 -f "parents[]=$ROOT" --jq .sha)
LABELS="none-admin none-persona layered-persona layered-admin"
# The branches that update and delete act on, made before the rulesets exist.
for l in $LABELS; do gh api -X POST repos/$R/git/refs -f ref=$T/$l -f sha=$ROOT --silent; done

ruleset() { # name, rules, bypass team id ("" for none)
  jq -n --arg n "$1" --argjson rules "$2" --arg team "$3" '{name:$n,target:"branch",enforcement:"active",
    conditions:{ref_name:{include:["refs/heads/chernabog/threads/**"],exclude:[]}},rules:$rules,
    bypass_actors:(if $team=="" then [] else [{actor_id:($team|tonumber),actor_type:"Team",bypass_mode:"always"}] end)}' |
    gh api -X POST repos/$R/rulesets --input - --jq .id
}
# A bypass covers every rule in its ruleset, so blocking force pushes sits with
# deletion, where only admins bypass, not with creation and update.
WRITE=$(ruleset threads-write '[{"type":"creation"},{"type":"update"}]' "")
DELETE=$(ruleset threads-delete '[{"type":"deletion"},{"type":"non_fast_forward"}]' "")

show() { grep -E '^HTTP/|^\{'; }
advance() { # token, branch, oid
  jq -n --arg b "$2" --arg o "$3" --arg r "$R" '{query:"mutation($i:CreateCommitOnBranchInput!){createCommitOnBranch(input:$i){commit{oid}}}",
    variables:{i:{branch:{repositoryNameWithOwner:$r,branchName:$b},expectedHeadOid:$o,message:{headline:"phase"},fileChanges:{}}}}' |
    GH_TOKEN=$1 gh api graphql --input - -i 2>&1 | show
}
probe() { # label, token
  echo "== $1"
  echo "-- POST /git/refs (new branch)"; GH_TOKEN=$2 gh api -X POST repos/$R/git/refs -f ref=$T/$1-new -f sha=$ROOT -i 2>&1 | show
  echo "-- PATCH /git/refs (fast-forward)"; GH_TOKEN=$2 gh api -X PATCH repos/$R/git/refs/heads/chernabog/threads/$1 -f sha=$CHILD -i 2>&1 | show
  H=$(gh api repos/$R/git/ref/heads/chernabog/threads/$1 --jq .object.sha)
  echo "-- createCommitOnBranch"; advance "$2" chernabog/threads/$1 $H
  echo "-- PATCH /git/refs (force, rewind)"; GH_TOKEN=$2 gh api -X PATCH repos/$R/git/refs/heads/chernabog/threads/$1 -f sha=$ROOT -F force=true -i 2>&1 | show
  echo "-- DELETE /git/refs"; GH_TOKEN=$2 gh api -X DELETE repos/$R/git/refs/heads/chernabog/threads/$1 -i 2>&1 | show
}
ADMIN_TOKEN=$(gh auth token)

# Q1, no bypass: every write should be refused, for the persona and the admin alike.
probe none-admin "$ADMIN_TOKEN"; probe none-persona "$DQ"

# Q5 and Q6, layered: the persona may create and update, not delete; the admin the reverse.
gh api -X PUT repos/$R/rulesets/$WRITE --input <(jq -n --argjson p $P '{bypass_actors:[{actor_id:$p,actor_type:"Team",bypass_mode:"always"}]}') --silent
gh api -X PUT repos/$R/rulesets/$DELETE --input <(jq -n --argjson d $D '{bypass_actors:[{actor_id:$d,actor_type:"Team",bypass_mode:"always"}]}') --silent
probe layered-persona "$DQ"; probe layered-admin "$ADMIN_TOKEN"

# Clean up.
gh api -X DELETE orgs/dataquail/teams/phase-test-personas; gh api -X DELETE orgs/dataquail/teams/phase-test-deleters
gh repo delete $R --yes   # needs the delete_repo scope
```

Expected if the design holds: with no bypass every write is refused, for the
persona and for the admin. Layered, the persona's `POST`, fast-forward `PATCH`
and advance succeed, and its forced rewind and its `DELETE` are refused. The
admin's `DELETE` succeeds, and everything else it tries is refused, its forced
rewind included: the admin bypasses `threads-delete`'s `non_fast_forward`, but
a rewind is still an update, and `threads-write`'s `update` rule doesn't exempt
it. Record each status here when it runs.

## Cleanup

**A person needs to delete `dataquail/chernabog-phase-test`.** The token used
has no `delete_repo` scope: `DELETE /repos/dataquail/chernabog-phase-test`
returned `403 "Must have admin rights to Repository."` No teams or rulesets
were created. The repo holds only the test's branches and workflow; it can
instead be made public and reused for the ruleset script, which deletes it at
the end.
