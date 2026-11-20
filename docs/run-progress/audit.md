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

| #   | Source                                                                                               | Reads instead of the record                                                                                                                                                             | What a person can do to it                                                                                                            | Record it should read                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1  | `Implement.readied` (`implement.ts:1702`)                                                            | The `auto:awaiting-ready` label                                                                                                                                                         | Remove the label, and the parked run is never woken. It sits until its 14-day timeout.                                                | issue `awaiting-ready`, which `awaitReady` already writes (`implement.ts:1686`)                                                                                                                                    |
| S2  | `Plan.answers` (`plan.ts:374`)                                                                       | The `auto:plan-proposed` label, which the run applies (`plan.ts:548`)                                                                                                                   | Remove the label, and the waiting plan run is stranded until its 14-day timeout.                                                      | issue `proposed`, declared (`plan-blocks.ts:208`) but never written                                                                                                                                                |
| S3  | `baseTurnedGreen` (`pull-request.ts:697`)                                                            | `auto:ship` and the `chernabog-merge-hold` comment markers                                                                                                                              | Remove `auto:ship` from a held pull request, or delete the hold comment, and the parked run is never woken when the base turns green. | pull request `merge-held`, which `holdWhileBaseRed` writes (`pull-request.ts:637`)                                                                                                                                 |
| S4  | `Epic.queued` (`epic.ts:553`)                                                                        | A fingerprint in the persona's latest status comment. The fingerprint hashes sub-issue state, kinds from labels, and each layer pull request's head and review count.                   | Delete or edit the comment, and no layer-changed signal goes out. Dismiss a review or relabel a task, and the run wakes for nothing.  | epic `waiting`, declared (`epic-blocks.ts:1054`) but never written                                                                                                                                                 |
| S5  | `pr.mergedRecently` and post-merge's trigger (`post-merge-blocks.ts:762`, `flows/post-merge.ts:183`) | The `post-merge-watched` comment marker                                                                                                                                                 | Delete the marker within a day of the merge, and a second run watches the same merge.                                                 | **Done:** pull request `watched`, which the recipe and `merged.markWatched` write (`mark-watched`), carrying the merge commit's sha. The marker counts only for a merge with no `watched` record, until backfill   |
| S6  | `askedOf` (`review.ts:186`)                                                                          | This persona's review count, to tell a first review from a re-review. It is used for a pull request with no record, and for one recorded `review-asked`, `draft` or `ready-for-person`. | Hard for a person to change: only the persona's own reviews count.                                                                    | **Done:** the record alone. No record is a person's pull request, a first review. Whether the persona reviewed before a hand-off is the record's `reviewed` data, which the hand-off and `pr.readyForPerson` write |
| S7  | Legacy keys (`review.ts:256`, `review.ts:884`)                                                       | `pr-N-review-K` and `pr-N-changes-K`, where K counts reviews. Used only for a pull request with no record.                                                                              | Dismiss a decisive review or add one, and K changes, which looks like new work.                                                       | **Done:** `keyFor` on the record. A changes-requested review on a pull request with no record is reconciled to `changes-asked` first                                                                               |

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

| #   | Wait                                                                                                                                              | Waits for                                             | Daemon                                   | CI                                       | Phase today                                                                                                             | Starts again from the record?                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | `awaitReady` (`implement.ts:1683`)                                                                                                                | A person marking an adopted draft ready               | Journal                                  | **Stranded**                             | issue `awaiting-ready`                                                                                                  | No: `readied` is wake-only                                                                                                               |
| W2  | `Plan.awaitAnswer` (`plan.ts:557`)                                                                                                                | A person approving or commenting on a plan            | Journal                                  | **Stranded**                             | none (`proposed` declared, not written)                                                                                 | No: `answers` is wake-only                                                                                                               |
| W3  | `parkOnBase` (`pull-request.ts:539`), from review, re-review and `pr.land`                                                                        | The base branch's CI turning green                    | Journal                                  | **Stranded**                             | pull request `merge-held`                                                                                               | No: `baseTurnedGreen` is wake-only                                                                                                       |
| W4  | `waitForCi` for a new or resumed pull request (`flows/implement.ts:137-142, 201-206`) and address-review's fix (`flows/address-review.ts:92-128`) | The pull request's CI                                 | Polls                                    | Parks                                    | `awaiting-ci[-n]`                                                                                                       | Yes, in CI: `awaitingCi`, `fixesAwaitingCi`                                                                                              |
| W5  | `waitForCi` for an adopted pull request (`flows/implement.ts`, the adopted path; `ci.waitPreparing` at `adoptedCi`)                               | The pull request's CI                                 | Parks                                    | Parks                                    | issue `awaiting-ci[-n]`, with the adopted `pullRequest` and `since`                                                     | Yes: `awaitingCi` finds the pull request from the record's data, and `Resume.parked`, once CI settles or `ciTimeout` from `since` passes |
| W6  | resolve-conflicts' CI (`Conflict.waitForCi`, from `flows/resolve-conflicts.ts` and `conflict.waitForCi`)                                          | CI on the merge commit                                | Parks                                    | Parks                                    | pull request `awaiting-conflict-ci[-n]`, with `restore` (the review phase it parked over) and `since`                   | Yes: `Conflict.parkedOnCi` and `Resume.parked`, once CI settles or `ciTimeout` from `since` passes; the review phase is recorded again   |
| W7  | Epic task CI (`flows/epic.ts`, `ci.waitAndFix` in a lane) and stack refresh (`Stack.refreshLayer`)                                                | CI on a task's or a layer's pull request              | Task CI: leaves the lane; refresh: polls | Task CI: leaves the lane; refresh: polls | Task CI: epic `waiting`, with the task's `PendingCi` in `tasks.ci`; refresh: none                                       | Task CI: yes, `Epic.queued` once CI settles or `ciTimeout` from `since` passes, then `Epic.takeUpCi` / `epic.settleCi`. Refresh: no      |
| W8  | Blocks: `ci.waitPreparing`, `ci.waitAndFix`, `author.waitForCi`, `plan.awaitAnswer`, `pr.land`, `conflict.waitForCi`, `hybrid.waitForCi`          | CI, a person's answer to a plan, the base branch's CI | Parks                                    | Parks                                    | `awaiting-ci[-n]`, `proposed` (with the round), `merge-held` or `awaiting-conflict-ci`, with the node                   | Yes for all but the last: `Resume.parked`. Where a node can't resume, the first six poll. `hybrid.waitForCi` polls                       |
| W9  | post-merge's `awaitMergeCi` (`flows/post-merge.ts`) and `merged.awaitCi`                                                                          | Push CI on the merge commit                           | Parks                                    | Parks                                    | pull request `watched` (S5), then `awaiting-merge-ci` with the sha and `since`, and `watched` again when the watch ends | Yes: the recipe's trigger and `Resume.parked`, once CI settles or `noCiGrace`/`ciTimeout` from `since` passes                            |
| W10 | Epic park (`flows/epic.ts:884`, `epic.park`)                                                                                                      | A layer changing                                      | Journal                                  | Restarts fresh on every sweep            | none (`waiting` declared, not written)                                                                                  | Partly: `Epic.queued` restarts it from GitHub, and loses `attempts`                                                                      |

W8 leaves one block polling, `hybrid.waitForCi`. Polling is not a park, so it
isn't stranded.
W9 parks on `awaiting-merge-ci`, not on `watched`, which both triggers take for
finished: a second advance to `watched` by the same writer is a retry that
keeps the old data. The run that takes the watch up records `watched` again.
`since` in the data, not the record's `at`, is when the watch began, so the
grace and the timeout count across the runs that take it up. Both forms wake
on any finished CI run (`Events.baseCiCompleted`): a push run's branch is the
base, which names no item.
`plan.awaitAnswer` resumes in a repeat's round: the record keeps the round, and
`plan.propose` keeps its spec and round and reads the plan back from its comment.
`pr.land` resumes from its hold's record, which still names the work item that
holds it, so the hold counts its time from when it began.
W6 is done, in the recipe and `conflict.waitForCi` alike. `awaiting-ci` on a pull
request is address-review's wait on its own fix, so resolve-conflicts parks on
`awaiting-conflict-ci` instead, over the review phase the pull request's record
holds, such as `review-asked`. Its data keeps that record, phase and data, as
`restore`, and the run that takes the wait up records it again however the wait
ends, short of a park (ADR 21, decision 4). While it is parked, review holds a
review request with why, and no other source reads the phase. A pull request with
no record, or one whose record doesn't fit beside the rest, polls until backfill.
`hybrid.waitForCi` runs in a flow a person starts, which has no trigger to offer
the item again, so it polls.

Out of scope: `workWithPerson` (`hybrid.ts:206`) waits on a person in an interactive
session that chernabog opened for them. It is a manual flow, and the wait is the work.

Every wait for CI that parks keeps `since` in its record's data, when the
round's wait began. A run that takes it up and finds CI still pending past
`ciTimeout` from `since` hands it to a person, and the sources (`awaitingCi`,
`fixesAwaitingCi`, `Conflict.parkedOnCi`, the blocks' `parks`) stop holding it
then (`Implement.heldOnCi`). A record parked before `since` holds while CI
pends, as before. W5 parks on the issue's record as W4 does, which keeps the
adopted pull request, and the resumed run hands it off as an adopted one.

W4 was the first wait that followed the rule, and only in CI: `RepoSettings.ciJob`
gated `parkingOn`. Since a daemon run ends at every park (fix-order step 4), the
gate is gone, and a daemon's wait for CI parks too.

## Backfill

`chernabog progress backfill --repo <repo>` (`backfill.ts`, run through the
repo's own SDK as `ci plan` runs its `Events`) writes a record for each open
item that needs one and holds none. It infers the phase from the same GitHub
facts the no-record paths read, the one time ADR 21 allows that, and writes it
as `observer:backfill`. It prints what it would write; `--write` writes. Each
write advances from no record, so an item a run recorded since the survey
keeps the run's record, and a second run finds nothing to write. Where the
facts don't settle a phase, it writes nothing and lists the item for a person.

Pull requests: open ones an agent wrote (`auto/` head), a run adopted
(`auto:adopted`), or one of the repo's personas is asked to review or has
reviewed. The first row that matches decides.

| #   | GitHub says                                                                                                                             | Phase                | Data                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------- |
| P1  | Reviewers are asked, and every one of them has reviewed it before (any review, as `legacyAsked` counted)                                | `review-asked-again` |                             |
| P2  | Reviewers are asked, none has reviewed it, and nobody has approved it or asked for changes                                              | `review-asked`       |                             |
| P3  | Reviewers are asked, and some reviewed before while others didn't, or another reviewer's decisive review is there already               | for a person         |                             |
| P4  | No review asked; `auto:ship`, not `auto:needs-human`; the hold markers name one work item; the latest decisive review approves the head | `merge-held`         | `key`, from the hold marker |
| P5  | As P4, but the markers name several work items, or the latest decisive review doesn't approve the head                                  | for a person         |                             |
| P6  | No review asked; the latest decisive review asks for changes, on the head or before a push since                                        | `changes-asked`      |                             |
| P7  | No review asked; the latest decisive review approves                                                                                    | `approved`           |                             |
| P8  | No review asked or given; an agent's draft                                                                                              | `draft`              |                             |
| P9  | No review asked or given, otherwise: handed to a person, or a request was taken off                                                     | for a person         |                             |

A hold marker on a pull request labelled `auto:needs-human` is a hold that
ended, so P4 skips it and P7 reads the approval. P6 covers changes asked
before a push: `review.round` recorded `changes-asked` then, and nothing moved
it since, so `review.changesRequested` holds it, with why, until the reviewer
is asked again.

Issues and epics:

| #   | GitHub says                                                                                    | Phase            | Data                                                                     |
| --- | ---------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------ |
| I1  | `auto:awaiting-ready`, and the latest claim marker adopted a draft                             | `awaiting-ready` | `pullRequest` from the marker; `withinMillis` 14 days, the recipe's wait |
| I2  | `auto:plan-proposed`, and a plan was posted                                                    | `proposed`       | `round`, from the latest plan marker                                     |
| —   | `auto:awaiting-ready` with no adopted draft, `auto:plan-proposed` with no plan, or both labels | for a person     |                                                                          |
| E1  | `auto:epic`, a task open, and a persona's status comment                                       | epic `waiting`   | the status comment's `fingerprint`; no task attempts kept                |
| —   | Any other open issue or epic: queued, in progress, or never run                                | none             | no record is its phase                                                   |

What it can't backfill, and leaves to the legacy path or to time:

- A record's `at` is when backfill wrote it, so a backfilled
  `awaiting-ready`, `proposed` or `merge-held` counts its 14-day wait or
  `mergeHoldTimeout` from then, not from when the wait began.
- A flow document's parked run keeps the node it parked at in its record
  (`resume`), which no marker gives. A backfilled `proposed` or `merge-held`
  wakes a daemon's run still parked in its journal, and a recipe's run takes
  it up from the record; a document's run that a CI job left there stays
  stranded, as it was.
- An epic's backfilled `waiting` keeps no task attempts, as the restart from
  GitHub lost them before (W10).
- A pull request's CI waits (`awaiting-ci`, `awaiting-conflict-ci`,
  `awaiting-merge-ci`) always wrote their record, so none needs backfill. A
  resolve-conflicts wait over a pull request with no record polls (W6) and
  parks once backfill gives it one.

Neither `doctor` nor `recipes upgrade` suggests running it. It is a one-time
step of the upgrade that removes the no-record paths (S6, S7), and that
release's notes say to run it first. Every later run writes a record at each
handoff, so a repo needs it once.

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
   post-merge come first, then the blocks, then the epic. W8 and W10 are done,
   and W9 is: post-merge's watch parks on `awaiting-merge-ci` and both
   triggers offer it once push CI settles or its time is up. So is W6:
   resolve-conflicts parks on `awaiting-conflict-ci` and puts the review
   phase back. So is W5: an adopted pull request's wait parks on the issue's
   `awaiting-ci`, whose data keeps the pull request. W7's task CI is: a task's
   lane whose CI is pending ends there, the epic parks with it in its
   `waiting` record (`tasks.ci`), and a later round takes it up once CI
   settles. The stack refresh's wait for CI still polls; it is the next layer.
7. **Backfill, then S6 and S7:** `chernabog progress backfill` writes a record
   for every open item without one. Then the no-record paths go. Done:
   backfill ([Backfill](#backfill)), then S6 and S7, so the review sources read
   the record alone. Upgrade order: see [Upgrading](#upgrading-to-s6-and-s7)
   below.

## S6 and S7: the review sources read the record alone

- **No record is a first review.** `askedOf` no longer counts this persona's
  reviews. A pull request with no record is one a person opened, since
  backfill gave every older one a record, and a review asked of it is
  `review.requested`'s.
- **Reviewed before the record.** A record of `review-asked`, `draft` or
  `ready-for-person` carries `reviewed`, who had reviewed the pull request
  when it was written (`Phases.recordAwaitingReview`: the hand-off,
  `pr.readyForPerson`, and backfill's P2 and P8). A review asked of one of
  them is a review again (`review.requestedAgain` reconciles), as the count
  said for an adopted pull request this persona reviewed before the
  hand-off, and for one `pr.readyForPerson` gave a person after a review. A
  record written before this release has no `reviewed`, so a review asked
  of it is a first, whoever reviewed before. That covers a hand-off record
  and a P2 record written by an earlier release's backfill (#544) alike:
  a persona that had only commented when it was written gets a first
  review, not a re-review. Rerunning backfill doesn't add `reviewed`,
  since it skips an item that has a record.
- **Keys.** `pr-N-review-K` and `pr-N-changes-K` are gone. A request to
  review again keys by its `review-asked-again` record, and a review asking
  for changes on a pull request with no record moves it to `changes-asked`
  first (`observer:review.changesRequested`), then keys by that.
- **Runs in flight under a legacy key.** A run started before the upgrade
  keeps its old key; its pull request's next item has a record key, which
  is new work. That starts no second run on the pull request while the old
  one lives: the review sources skip a pull request a run owns by its claim
  ref (`ownedByARun`), address-review and resolve-conflicts claim it, and a
  CI plan job reserves an item by its claim (`pr-N`), not its key (#520). A
  merge a legacy re-review run holds keeps `pr-N-review-K` in its
  `merge-held` data, which re-review's `heldMerges` still owns
  (`pr-N-` prefix).

### Upgrading to S6 and S7

Backfill (#544) and S6 and S7 (#545) are in one stack, so the release order
decides the upgrade order:

- **One release with both** (the default): no binary has backfill without
  S6 and S7, so backfill can't run first. Stop the daemon, upgrade, run
  `chernabog progress backfill --repo <repo> --write` on each repo, then
  start the daemon, so no tick reads a repo before its backfill. Runs in
  flight under a legacy key are covered above. Every backfill record then
  carries `reviewed`.
- **A release between them**: run that release's backfill on each repo, let
  review runs in flight finish, then upgrade. Its P2 records have no
  `reviewed`, so a pull request whose persona had only commented gets a
  first review once, after the upgrade, instead of a re-review.

## What this changes in handoffs.md

[handoffs.md](handoffs.md) was written before #454 and #514 to #516. Where they
disagree, the code and this audit win:

- **Old "reads today" columns.** Rows I2, R1, A1 and C3 and question 3's
  review rows now describe the record-only reading (S6, S7).
- **Question 3's table is a target.** Its rows for `epic.queued`,
  `Implement.readied` and `Plan.answers` aren't built. `pr.mergedRecently`'s
  is.
- **Missing phases.** It doesn't mention `awaiting-ci` or the CI park and resume.
