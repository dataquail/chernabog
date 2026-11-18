# Run progress: where the code breaks ADR 21

Audit of `main` at 32d0e79a (#520) against
[ADR 21](../adr/0021-one-ledger-the-forge-is-input.md). Decision 3 says a source reads
progress only from the record. Decision 4 says every wait on a person or another
system is a park, and a parked phase is startable work. This lists every place that
breaks either rule, and the fix for each. Paths without a directory are under
`packages/sdk/src/`.

The worst finding: three waits strand their item in a CI job (W1 to W3). Each parks
in the run's journal, and its source only wakes that run (`wakeOnly`). A CI job ends
at the park and throws its journal away. Both `ci plan` and `ci run` start only items
that pass `mayStart`, which excludes wake-only items
(`src/modules/runs/domain/run/work-item.value-object.ts:35`,
`src/modules/runs/domain/domain-services/ci-plan.domain-service.ts:198`,
`src/interface/cli/ci-run.main.ts:290`). So nothing starts the item again. This was
found by reading the code; no test reproduces it yet.

## Sources that read progress from the world (decision 3)

Ranked by how easily a person editing GitHub can derail a run.

| #   | Source                                                                                               | Reads instead of the record                                                                                                                                                             | What a person can do to it                                                                                                            | Record it should read                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `Implement.readied` (`implement.ts:1702`)                                                            | The `auto:awaiting-ready` label                                                                                                                                                         | Remove the label, and the parked run is never woken. It sits until its 14-day timeout.                                                | issue `awaiting-ready`, which `awaitReady` already writes (`implement.ts:1686`)                                                                                                                                  |
| S2  | `Plan.answers` (`plan.ts:374`)                                                                       | The `auto:plan-proposed` label, which the run applies (`plan.ts:548`)                                                                                                                   | Remove the label, and the waiting plan run is stranded until its 14-day timeout.                                                      | issue `proposed`, declared (`plan-blocks.ts:208`) but never written                                                                                                                                              |
| S3  | `baseTurnedGreen` (`pull-request.ts:697`)                                                            | `auto:ship` and the `chernabog-merge-hold` comment markers                                                                                                                              | Remove `auto:ship` from a held pull request, or delete the hold comment, and the parked run is never woken when the base turns green. | pull request `merge-held`, which `holdWhileBaseRed` writes (`pull-request.ts:637`)                                                                                                                               |
| S4  | `Epic.queued` (`epic.ts:553`)                                                                        | A fingerprint in the persona's latest status comment. The fingerprint hashes sub-issue state, kinds from labels, and each layer pull request's head and review count.                   | Delete or edit the comment, and no layer-changed signal goes out. Dismiss a review or relabel a task, and the run wakes for nothing.  | epic `waiting`, declared (`epic-blocks.ts:1054`) but never written                                                                                                                                               |
| S5  | `pr.mergedRecently` and post-merge's trigger (`post-merge-blocks.ts:762`, `flows/post-merge.ts:183`) | The `post-merge-watched` comment marker                                                                                                                                                 | Delete the marker within a day of the merge, and a second run watches the same merge.                                                 | **Done:** pull request `watched`, which the recipe and `merged.markWatched` write (`mark-watched`), carrying the merge commit's sha. The marker counts only for a merge with no `watched` record, until backfill |
| S6  | `askedOf` (`review.ts:186`)                                                                          | This persona's review count, to tell a first review from a re-review. It is used for a pull request with no record, and for one recorded `review-asked`, `draft` or `ready-for-person`. | Hard for a person to change: only the persona's own reviews count.                                                                    | The record alone, once every open pull request has one                                                                                                                                                           |
| S7  | Legacy keys (`review.ts:256`, `review.ts:884`)                                                       | `pr-N-review-K` and `pr-N-changes-K`, where K counts reviews. Used only for a pull request with no record.                                                                              | Dismiss a decisive review or add one, and K changes, which looks like new work.                                                       | `keyFor` on the record, as recorded pull requests already use                                                                                                                                                    |

Borderline, and left as they are:

- **Queue labels** (`auto:eligible`, `auto:ship`, `auto:plan`) are intent. A claim
  takes them off, so "label present" also means "not started". The record could say
  that, but a person putting the label back is a real request to run again.
- **`auto:needs-human`** is a pause that a run applies and a person removes. That is
  intent both ways.
- **`auto:adopted`** decides who owns a pull request (`review.ts:853`), not how far
  it got.
- The adopted pull request's number comes from the claim marker comment
  (`implement.ts:1709`), because a record carries no payload. Deleting that comment
  strands an adopted draft. A record payload, or an `Items` link from the issue to
  the pull request (ADR 21, decision 6), would remove it.

## Waits that don't park (decision 4)

"Polls" means a durable sleep between readings inside the run. "Journal" means the
run parks in its local workflow journal, and a signal wakes it.

| #   | Wait                                                                                                                                              | Waits for                                             | Daemon  | CI                            | Phase today                                                                   | Starts again from the record?                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------- | ----------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | `awaitReady` (`implement.ts:1683`)                                                                                                                | A person marking an adopted draft ready               | Journal | **Stranded**                  | issue `awaiting-ready`                                                        | No: `readied` is wake-only                                                                                                                      |
| W2  | `Plan.awaitAnswer` (`plan.ts:557`)                                                                                                                | A person approving or commenting on a plan            | Journal | **Stranded**                  | none (`proposed` declared, not written)                                       | No: `answers` is wake-only                                                                                                                      |
| W3  | `parkOnBase` (`pull-request.ts:539`), from review, re-review and `pr.land`                                                                        | The base branch's CI turning green                    | Journal | **Stranded**                  | pull request `merge-held`                                                     | No: `baseTurnedGreen` is wake-only                                                                                                              |
| W4  | `waitForCi` for a new or resumed pull request (`flows/implement.ts:137-142, 201-206`) and address-review's fix (`flows/address-review.ts:92-128`) | The pull request's CI                                 | Polls   | Parks                         | `awaiting-ci[-n]`                                                             | Yes, in CI: `awaitingCi`, `fixesAwaitingCi`                                                                                                     |
| W5  | `waitForCi` for an adopted pull request (`flows/implement.ts:168-176`)                                                                            | The pull request's CI                                 | Polls   | Polls                         | none                                                                          | No: `awaitingCi` looks for the pull request on `auto/issue-N`, not the adopted one's branch                                                     |
| W6  | resolve-conflicts' CI (`flows/resolve-conflicts.ts:291`)                                                                                          | CI on the merge commit                                | Polls   | Polls                         | none                                                                          | No                                                                                                                                              |
| W7  | Epic task CI (`flows/epic.ts:275`) and stack refresh (`stack.ts:610`)                                                                             | CI on a task's or a layer's pull request              | Polls   | Polls                         | none per task                                                                 | No: lanes live in memory                                                                                                                        |
| W8  | Blocks: `ci.waitPreparing`, `ci.waitAndFix`, `author.waitForCi`, `plan.awaitAnswer`, `pr.land`, `conflict.waitForCi`, `hybrid.waitForCi`          | CI, a person's answer to a plan, the base branch's CI | Parks   | Parks                         | `awaiting-ci[-n]`, `proposed` (with the round) or `merge-held`, with the node | Yes for all but the last two: `Resume.parked`. Where a node can't resume, the first five poll. `conflict.waitForCi` and `hybrid.waitForCi` poll |
| W9  | post-merge's `awaitMergeCi` (`flows/post-merge.ts:279`)                                                                                           | Push CI on the merge commit                           | Polls   | Polls                         | pull request `watched`, with the sha, written before the wait (S5)            | No                                                                                                                                              |
| W10 | Epic park (`flows/epic.ts:884`, `epic.park`)                                                                                                      | A layer changing                                      | Journal | Restarts fresh on every sweep | none (`waiting` declared, not written)                                        | Partly: `Epic.queued` restarts it from GitHub, and loses `attempts`                                                                             |

W8 leaves two blocks polling. Polling is not a park, so neither is stranded.
`plan.awaitAnswer` resumes in a repeat's round: the record keeps the round, and
`plan.propose` keeps its spec and round and reads the plan back from its comment.
`pr.land` resumes from its hold's record, which still names the work item that
holds it, so the hold counts its time from when it began.
`conflict.waitForCi` would record `awaiting-ci` over the review phase that the
pull request's record holds, such as `review-asked`, and nothing writes that phase
back. W6 decides where a resolve-conflicts wait lives. `hybrid.waitForCi` runs in
a flow a person starts, which has no trigger to offer the item again.

Out of scope: `workWithPerson` (`hybrid.ts:206`) waits on a person in an interactive
session that chernabog opened for them. It is a manual flow, and the wait is the work.

W4 is the one wait that already follows the rule, and only in CI. `RepoSettings.ciJob`
is read in exactly one place, `parkingOn` (`implement.ts:1422`). It is the only thing
that makes `waitForCi` record and park. On a daemon the same flow polls.

## Order of the fixes

Each fix is its own pull request.

1. **S1:** `readied` reads the `awaiting-ready` record.
2. **Core: `at` and `data` on the record** (ADR 21, decision 4). The git adapter
   takes `at` from the commit's date and keeps `data` in the commit body. The
   contract suite covers both.
3. **A test that reproduces W1 in a CI job**, then **W1 to W3:** a source
   reports a startable item for each parked phase, and the flow resumes from the
   record. `at` gives the 14-day and merge-hold deadlines. `data` carries the
   adopted pull request, the plan's round and when the hold began. S2's
   `proposed` and S3's `merge-held` are read along the way.
4. **A daemon run ends at a park.** The engine lets a daemon run end at a park,
   as `ci run` does today. A watch of parked records marks a flow due when the
   fact it waits on settles. Then the `ciJob` gate in `parkingOn` goes, and W4
   parks on a daemon too.
5. **S2 to S5:** the remaining sources read their records, and the recipes write
   the phases that today only the documents declare. S5 is done: post-merge's
   recipe and document both write `watched`, and both triggers read it, with
   the marker only for a merge watched before.
6. **W5 to W10:** each CI wait gets a phase and a source. Resolve-conflicts and
   post-merge come first, then the blocks, then the epic.
7. **Backfill, then S6 and S7:** `chernabog progress backfill` writes a record
   for every open item without one. Then the no-record paths go.

## What this changes in handoffs.md

[handoffs.md](handoffs.md) was written before #454 and #514 to #516. Where they
disagree, the code and this audit win:

- **Old "reads today" columns.** Rows I2, R1, A1 and C3 still describe the review
  sources' `reviewed === 0` reading. Those sources now read the record first.
- **Question 3's table is a target.** Its rows for `epic.queued`,
  `Implement.readied` and `Plan.answers` aren't built. `pr.mergedRecently`'s
  is.
- **Missing phases.** It doesn't mention `awaiting-ci` or the CI park and resume.
