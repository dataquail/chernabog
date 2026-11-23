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
| S1  | `Implement.readied` (`implement.ts:1702`)                                                            | The `auto:awaiting-ready` label                                                                                                                                                         | Remove the label, and the parked run is never woken. It sits until its 14-day timeout.                                                | **Done (#525, #530).** issue `awaiting-ready`, which `awaitReady` already writes (`implement.ts:1686`)                                                                                                             |
| S2  | `Plan.answers` (`plan.ts:374`)                                                                       | The `auto:plan-proposed` label, which the run applies (`plan.ts:548`)                                                                                                                   | Remove the label, and the waiting plan run is stranded until its 14-day timeout.                                                      | **Done (#532, #563).** issue `proposed`, declared (`plan-blocks.ts:208`) but never written                                                                                                                         |
| S3  | `baseTurnedGreen` (`pull-request.ts:697`)                                                            | `auto:ship` and the `chernabog-merge-hold` comment markers                                                                                                                              | Remove `auto:ship` from a held pull request, or delete the hold comment, and the parked run is never woken when the base turns green. | **Done (#533).** pull request `merge-held`, which `holdWhileBaseRed` writes (`pull-request.ts:637`)                                                                                                                |
| S4  | `Epic.queued` (`epic.ts:553`)                                                                        | A fingerprint in the persona's latest status comment. The fingerprint hashes sub-issue state, kinds from labels, and each layer pull request's head and review count.                   | Delete or edit the comment, and no layer-changed signal goes out. Dismiss a review or relabel a task, and the run wakes for nothing.  | **Done (#536); the epic's record holds its own state only (#568).** epic `waiting`, declared (`epic-blocks.ts:1054`) but never written                                                                             |
| S5  | `pr.mergedRecently` and post-merge's trigger (`post-merge-blocks.ts:762`, `flows/post-merge.ts:183`) | The `post-merge-watched` comment marker                                                                                                                                                 | Delete the marker within a day of the merge, and a second run watches the same merge.                                                 | **Done:** pull request `watched`, which the recipe and `merged.markWatched` write (`mark-watched`), carrying the merge commit's sha. The marker counts only for a merge with no `watched` record, until backfill   |
| S6  | `askedOf` (`review.ts:186`)                                                                          | This persona's review count, to tell a first review from a re-review. It is used for a pull request with no record, and for one recorded `review-asked`, `draft` or `ready-for-person`. | Hard for a person to change: only the persona's own reviews count.                                                                    | **Done:** the record alone. No record is a person's pull request, a first review. Whether the persona reviewed before a hand-off is the record's `reviewed` data, which the hand-off and `pr.readyForPerson` write |
| S7  | Legacy keys (`review.ts:256`, `review.ts:884`)                                                       | `pr-N-review-K` and `pr-N-changes-K`, where K counts reviews. Used only for a pull request with no record.                                                                              | Dismiss a decisive review or add one, and K changes, which looks like new work.                                                       | **Done:** `keyFor` on the record. A changes-requested review on a pull request with no record is reconciled to `changes-asked` first                                                                               |

Borderline, and left as they are:

- **Queue labels** (`auto:eligible`, `auto:ship`, `auto:plan`) are intent. A claim
  takes them off, so "label present" also means "not started". The record could say
  that, but a person putting the label back is a real request to run again.
- **`auto:needs-human`** was a pause that a run applies and a person removes, so
  intent both ways. It is no longer borderline: ADR 21's amended decision 1 makes "with a
  person" a phase and the label its projection. Every read is a gap,
  [H1 to H12](#the-world-read-back-as-a-record-epic-557).
- **`auto:adopted`** decides who owns a pull request, not how far it got. It is no
  longer borderline either: amended decision 8 makes it a status label the projector
  writes (L5), and adoption is a claim's fact (decision 7). Its reads are gaps,
  [R1 and R2](#other-status-labels-read-back-as-a-record-decision-8).
- The adopted pull request's number comes from the claim marker comment
  (`implement.ts:1709`), because a record carries no payload. Deleting that comment
  strands an adopted draft. A record payload, or an `Items` link from the issue to
  the pull request (ADR 21, decision 6), would remove it. The record's data now
  carries it (`awaiting-ready`'s `pullRequest`); the claim marker's other reads are
  [M8 and M9](#the-world-read-back-as-a-record-epic-557).

## Waits that don't park (decision 4)

"Polls" means a durable sleep between readings inside the run. "Journal" means the
run parks in its local workflow journal, and a signal wakes it.

| #   | Wait                                                                                                                                              | Waits for                                             | Daemon                                                  | CI                                                      | Phase today                                                                                                                                                                     | Starts again from the record?                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | `awaitReady` (`implement.ts:1683`)                                                                                                                | A person marking an adopted draft ready               | Journal                                                 | **Stranded**                                            | issue `awaiting-ready`                                                                                                                                                          | **Done (#530).** No: `readied` is wake-only                                                                                                                                                                                                                                   |
| W2  | `Plan.awaitAnswer` (`plan.ts:557`)                                                                                                                | A person approving or commenting on a plan            | Journal                                                 | **Stranded**                                            | none (`proposed` declared, not written)                                                                                                                                         | **Done (#532).** No: `answers` is wake-only                                                                                                                                                                                                                                   |
| W3  | `parkOnBase` (`pull-request.ts:539`), from review, re-review and `pr.land`                                                                        | The base branch's CI turning green                    | Journal                                                 | **Stranded**                                            | pull request `merge-held`                                                                                                                                                       | **Done (#533).** No: `baseTurnedGreen` is wake-only                                                                                                                                                                                                                           |
| W4  | `waitForCi` for a new or resumed pull request (`flows/implement.ts:137-142, 201-206`) and address-review's fix (`flows/address-review.ts:92-128`) | The pull request's CI                                 | Polls                                                   | Parks                                                   | issue `awaiting-ci[-n]`; pull request `awaiting-fix-ci[-n]`                                                                                                                     | **Done (#535).** Yes, in CI: `awaitingCi`, `fixesAwaitingCi`                                                                                                                                                                                                                  |
| W5  | `waitForCi` for an adopted pull request (`flows/implement.ts`, the adopted path; `ci.waitPreparing` at `adoptedCi`)                               | The pull request's CI                                 | Parks                                                   | Parks                                                   | issue `awaiting-adopted-ci[-n]`, with the adopted `pullRequest` and `since`                                                                                                     | **Done (#542).** Yes: `awaitingCi` finds the pull request from the record's data, and `Resume.parked`, once CI settles or `ciTimeout` from `since` passes                                                                                                                     |
| W6  | resolve-conflicts' CI (`Conflict.waitForCi`, from `flows/resolve-conflicts.ts` and `conflict.waitForCi`)                                          | CI on the merge commit                                | Parks                                                   | Parks                                                   | pull request `awaiting-conflict-ci[-n]`, with `restore` (the review phase it parked over) and `since`                                                                           | **Done (#541).** Yes: `Conflict.parkedOnCi` and `Resume.parked`, once CI settles or `ciTimeout` from `since` passes; the review phase is recorded again                                                                                                                       |
| W7  | Epic task CI (`flows/epic.ts`, `ci.waitAndFix` in a lane) and stack refresh (`Stack.refreshLayer`, in `carryUp` and `catchUp`)                    | CI on a task's or a layer's pull request              | Parks: the lane or the refresh ends, and the epic parks | Parks: the lane or the refresh ends, and the epic parks | the task's issue `awaiting-task-ci` (`PendingCi`) and the layer's pull request `awaiting-refresh-ci` (`PendingRefresh`, its review phase in a blob)                             | **Done (#543, #546; #568 keeps the CI on the task's and the layer's own records).** Yes: `Epic.queued` once CI settles or `ciTimeout` from `since` passes, then `Epic.takeUpCi` / `epic.settleCi` and `Epic.takeUpRefreshes` (first in `carryUp`, recipe and `stack.carryUp`) |
| W8  | Blocks: `ci.waitPreparing`, `ci.waitAndFix`, `author.waitForCi`, `plan.awaitAnswer`, `pr.land`, `conflict.waitForCi`, `hybrid.waitForCi`          | CI, a person's answer to a plan, the base branch's CI | Parks                                                   | Parks                                                   | `awaiting-ci[-n]`, `awaiting-adopted-ci[-n]`, `awaiting-fix-ci[-n]`, `proposed` (with the round), `merge-held` (with the flow) or `awaiting-conflict-ci`, with only their facts | **Done (#537, #538, #567).** Yes for all but the last: `Resume.parked`, by the phase. Where a run can't take it up, the CI waits poll; `pr.land` and `plan.awaitAnswer` must be where it can. `hybrid.waitForCi` polls                                                        |
| W9  | post-merge's `awaitMergeCi` (`flows/post-merge.ts`) and `merged.awaitCi`                                                                          | Push CI on the merge commit                           | Parks                                                   | Parks                                                   | pull request `watched` (S5), then `awaiting-merge-ci` with the sha and `since`, and `watched` again when the watch ends                                                         | **Done (#539, #540).** Yes: the recipe's trigger and `Resume.parked`, once CI settles or `noCiGrace`/`ciTimeout` from `since` passes                                                                                                                                          |
| W10 | Epic park (`flows/epic.ts:884`, `epic.park`)                                                                                                      | A layer changing                                      | Journal                                                 | Restarts fresh on every sweep                           | none (`waiting` declared, not written)                                                                                                                                          | **Done (#536).** Partly: `Epic.queued` restarts it from GitHub, and loses `attempts`                                                                                                                                                                                          |

W8 leaves one block polling, `hybrid.waitForCi`. Polling is not a park, so it
isn't stranded.
W9 parks on `awaiting-merge-ci`, not on `watched`, which both triggers take for
finished: a second advance to `watched` by the same writer is a retry that
keeps the old data. The run that takes the watch up records `watched` again.
`since` in the data, not the record's `at`, is when the watch began, so the
grace and the timeout count across the runs that take it up. Both forms wake
on push CI finishing on the default branch (`Events.mergeCiCompleted`), and the
plan job looks only at the pull request whose record names that merge commit
(`Events.parkedOn`).
A document's run that takes a park up starts at the node whose block parks on
its phase, and the block takes the wait up from the record and the world
(`Block.parks.takeUp`); nothing the run before it gave carries over, and the
compiler holds the steps after a park to the trigger, the park block's output
and what comes after it (#567). `plan.awaitAnswer` takes up in a repeat's
round, which the record keeps, and reads an approved plan from the blob the
record names. `pr.land` takes up its hold's record, which names the work item
and the flow that hold it, so the hold counts its time from when it began.
W6 is done, in the recipe and `conflict.waitForCi` alike. `awaiting-fix-ci` on a pull
request is address-review's wait on its own fix, so resolve-conflicts parks on
`awaiting-conflict-ci` instead, over the review phase the pull request's record
holds, such as `review-asked`. Its data keeps that record, phase and data, as
`restore`, and the run that takes the wait up records it again however the wait
ends, short of a park (ADR 21, decision 4). While it is parked, review holds a
review request with why, and no other source reads the phase. A pull request with
no record polls until backfill.
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

## The world read back as a record (epic #557)

Audit of `main` at c38058b9 (#555) against ADR 21 as #557 amends it: the world is
input, never record. A park is a phase boundary (decision 4), "with a person" is a
phase (decision 1), chernabog's own outputs live in the ledger (decision 7), and
status labels are a projection that one projector writes (decision 8). This lists
every place left that reads the world back as a record, or that writes a status
label by hand, with the fix and the task in #557 that makes it. Line numbers are
at c38058b9.

### The journal outlives a phase (decision 4)

| #   | Where                                                                                                                                                            | What it carries across a park                                                                                       | Fix                                                                                                                                                                                                                                   | Task |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| J1  | Park sites that share a phase, such as implement's two waits for CI on the issue's `awaiting-ci` (`implement.ts:1953`, `phases.ts:48`)                           | Which wait it is, told apart only by `resume.node`                                                                  | **Done.** Every park site records a phase of its own (`Phases.PARKS`): the adopted wait is `awaiting-adopted-ci`, address-review's `awaiting-fix-ci`; `test/park-sites.test.ts` proves no two share one                               | #566 |
| J2  | `resume.ts:48`, `:52`, `:70`, `:101`, `:114`: `Block.keeps`, `Block.recall`, `kept` and `resume.node`                                                            | The node a document parked at and earlier steps' outputs, in the record's `data`                                    | **Done.** They go. A document resumes at the phase it parked on (`Resume.parked`, `Block.parks`); a node after a park reads only the trigger, its park block's output and what comes after it, and the compiler rejects anything else | #567 |
| J3  | The epic's `waiting` record: `tasks.ci` (`epic.ts:593`) and `layers.ci` (`epic.ts:627`), with `REFRESH_CI_SIZE` (`epic.ts:637`) and `SAID_SIZE` (`stack.ts:363`) | A task's or a layer's pending CI, copied into the epic's `data`, under a size budget that polls when it is exceeded | **Done.** A task's CI wait is on the task's `awaiting-task-ci`, a refresh's on the layer's pull request's `awaiting-refresh-ci`, and the epic reads those records (`Epic.leftOf`). The budgets are gone                               | #568 |

### `auto:needs-human` read back as "with a person" (decision 1)

Each reads the label where it should read the item's `with-person` record. #559
records `with-person` at every hand-off first; the reads move after it.

| #   | Where                                                                   | Reads the label to                                                                          | Fix                                                                                                                                                                                      | Task       |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| H1  | `implement.ts:1575`                                                     | Leave an issue parked on CI alone when its pull request went to a person                    | **Done (#560).** Read the pull request's record for `with-person`                                                                                                                        | #560       |
| H2  | `implement.ts:2001`                                                     | Skip an issue a person has, in the CI-wait source                                           | **Done (#560).** Read the issue's record                                                                                                                                                 | #560       |
| H3  | `plan.ts:463`, `plan.ts:585`                                            | Skip a spec a person has, in `Plan.answers` and the document's `proposed` source            | **Done (#560).** Read the spec's record                                                                                                                                                  | #560       |
| H4  | `epic.ts:72` (`Epic.kindOf`)                                            | Tell a plan's `human` task from an `auto` or `hybrid` one                                   | **Done (#560).** A `human` task is recorded `with-person` when it is created (#559); `kindOf` reads the record                                                                           | #560       |
| H5  | `epic.ts:339` (`personReason`)                                          | Say why a task the epic doesn't implement waits                                             | **Done (#560).** Read the task's record                                                                                                                                                  | #560       |
| H6  | `epic-blocks.ts:187`, `epic-blocks.ts:495`                              | Tell whether a stack layer's pull request is with a person, before a refresh or a landing   | **Done (#560).** Read the layer's pull request's record                                                                                                                                  | #560       |
| H7  | `review.ts:292`                                                         | Skip a request to review again of a pull request a person has                               | **Done (#561).** Read the pull request's record                                                                                                                                          | #561       |
| H8  | `review.ts:1023`, `review.ts:1124`                                      | Skip a pull request a person has, in `review.changesRequested` and the fix's CI-wait source | **Done (#561).** Read the pull request's record                                                                                                                                          | #561       |
| H9  | `conflict.ts:202`, `conflict.ts:252`, `resolve-conflicts-blocks.ts:522` | Skip a conflicting pull request a person has, in the recipe and the document                | **Done (#561).** Read the pull request's record                                                                                                                                          | #561       |
| H10 | `pull-request.ts:726`, `pull-request.ts:815`                            | Skip a held merge a person has (`heldMerges`, `baseTurnedGreen`)                            | **Done (#561).** Read the pull request's record                                                                                                                                          | #561       |
| H11 | A person removing the label                                             | Nothing reads it: today the next source just sees no label                                  | **Done (#559, #602; #570 keeps a hand-back a projection put the label back over).** An observer records `handed-back {from}` (#559); sources act on that record, never the phase it left | #560, #561 |
| H12 | `backfill.ts:189`                                                       | Infer a merge hold that ended                                                               | **Done (#559): it stays, and the lint rule exempts backfill.** Stays: backfill is the one place inference is allowed. It maps the label onto `with-person`                               | #559       |

### Other status labels read back as a record (decision 8)

Amended decision 8 makes every label chernabog writes, but the six intent labels, a
status label, and no source reads one. These read `auto:adopted` and
`auto:needs-clarification`, whose writes are L5 and L4. `auto:epic` and `hybrid` are
intent, so the epic source (`epic.ts:806`) and `epicRunTasks` (`implement.ts:166`)
keep finding epics by `auto:epic`.

| #   | Where                               | Reads the label to                                                       | Fix                                                                                                                                                                                                                | Task |
| --- | ----------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| R1  | `review.ts:854` (`authoredByMe`)    | Count an adopted pull request assigned to this persona as its own        | **Done:** `StatusLabels.saysAdopted` on the pull request's record (`adopted`), which hand-off writes and every record carries on; backfill's A1 writes it for one adopted before. The label is only its projection | #569 |
| R2  | `implement.ts:1047` (`withHistory`) | Tell the agent it is working on a pull request a person opened           | **Done:** the same, read from the pull request's current record                                                                                                                                                    | #569 |
| R3  | `epic.ts:335` (`personReason`)      | Say a task waits for answers to its questions, beside H5's `needs-human` | **Done (#560).** Read the task's `asked-questions` record                                                                                                                                                          | #560 |

Backfill's reads of these labels stay, as H12 does: `backfill.ts:147` and `:273`
(`auto:adopted`) and `:385` (`auto:awaiting-ready`) infer an item's first record
once. `:399` reads `auto:epic`, which is intent.

### Chernabog's outputs read back from comments (decision 7)

| #   | Where                                                                                                                                                   | Reads                                                                         | Fix                                                                                                                                                                                                                                  | Task |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| M1  | `plan.ts:373`, `plan.ts:380` (write), `plan.ts:386`                                                                                                     | `planMarker`: whether, and which round of, a plan was posted                  | **Done:** the plan is a ledger blob named in the spec's `proposed` record, beside the round and `after`, the newest comment before the plan's, where a person's answer starts; the comment is for people, its marker the round alone | #563 |
| M2  | `plan.ts:679`, `:688` (`Plan.posted`)                                                                                                                   | `planMarker`: the posted plan itself, by round                                | **Done:** `Plan.posted` reads the blob the record names; a record that names none goes to a person                                                                                                                                   | #563 |
| M3  | `backfill.ts:311`                                                                                                                                       | `planMarker`: the round of a plan posted before records                       | **Done:** backfill maps it onto the record and its blob, once (I2, I3)                                                                                                                                                               | #563 |
| M4  | `pull-request.ts:416` (`PullRequest.merge`)                                                                                                             | `reviewMarker`: the reviewed sha behind the merge gate                        | **Done:** the latest review (`sha`, `reviewer`, round, verdict) is `review` in the pull request's record's `data`, kept through the phases after it                                                                                  | #564 |
| M5  | `review.ts:816` (`latestOwnReview`, from `re-review-blocks.ts:76`)                                                                                      | `reviewMarker`: this persona's last review                                    | **Done:** reads the record's `review`                                                                                                                                                                                                | #564 |
| M6  | `review.ts:1205` (`read-review`)                                                                                                                        | `reviewMarker`: the review address-review answers, by its sha                 | **Done:** the round of the record's `review` at the reviewed sha                                                                                                                                                                     | #564 |
| M7  | `review.ts:1157` (`findAuthorSession`, from `review.ts:1171`, `stack.ts:617`, `stack.ts:715`); written at `implement.ts:1768`, `hybrid.ts:303`          | `sessionMarker`: the author's agent session                                   | **Done (#565).** The session is in the issue's `handed-off` record's `data`, naming the pull request (`Phases.authorOf`): that record stays while the pull request's moves through review                                            | #565 |
| M8  | `implement.ts:491` (`latestClaim`), from `implement.ts:593`, `implement.ts:709`, `hybrid.ts:133`; written at `implement.ts:392`, `:566`, `hybrid.ts:96` | `claimMarker`: the claim's run, branch, base and whether a person works on it | **Done (#565).** Which run holds the claim and its base are the claim ref's (`Base` trailer); an adopted pull request waited on before is named in the issue's record's `data`                                                       | #565 |
| M9  | `backfill.ts:289`                                                                                                                                       | `claimMarker`: an adopted draft from before records                           | **Done (#565).** Backfill maps it onto the record, once                                                                                                                                                                              | #565 |

The linking markers stay until `Items` (amended decision 6): `planNodeMarker`
(`epic.ts:86`), `followUpMarker` (`post-merge-blocks.ts:513`) and the epic status
comment's own marker. They link objects or deduplicate a write; they say nothing
about progress.

### Status labels written by hand (decision 8)

Each is a status label a flow adds or removes itself. #569 replaces every one with
the projector, which derives the labels from the record's phase and the claim after
each advance and claim change.

**Done (#569).** `StatusLabels` (`packages/sdk/src/status-labels.ts`) is the
projector. `StatusLabels.project` maps a record and a live claim to the labels;
`Phases.advance`, which every SDK write of a record goes through (`record`,
`reconcile`, backfill, acknowledging an anomaly), sets an item's status labels to
exactly that set afterwards, and so does `StatusLabels.acquire`, the one way the
SDK claims an item. An issue's in-progress label is held as core's `claimLabel`
marker, which `StatusLabels.release` and `releasing` drop and a run's end
releases, so it goes with the claim however the run ends. Adoption and an unasked
review are facts in the pull request's record (`adopted`, `unasked`), carried
through its later records, so `auto:adopted` and `auto:needs-review` are
projections too. `chernabog doctor` lists every open item whose labels differ from
their projection (`Ledger.labelDrift`). No row below writes a label any more.

| #   | Where                                                                                                                                                         | Label                                                                                | Task            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------- |
| L1  | `implement.ts:511`, `:512` (on claim; the `Markers.hold(Markers.label, …)` takes it off when the run ends), `implement.ts:532` (`dropInProgress`, on release) | `auto:in-progress`                                                                   | **Done** (#569) |
| L2  | `implement.ts:575` (`referToPerson`), `implement.ts:2082`, `:2086` (`Implement.handToHuman`)                                                                  | `auto:needs-human` on the issue and its pull request                                 | **Done** (#569) |
| L3  | `implement.ts:640` (`Markers.hold(Markers.label, …)`, off when the run ends), `:641`                                                                          | `auto:awaiting-ready`                                                                | **Done** (#569) |
| L4  | `implement.ts:1167`                                                                                                                                           | `auto:needs-clarification`                                                           | **Done** (#569) |
| L5  | `implement.ts:1772`                                                                                                                                           | `auto:adopted`                                                                       | **Done** (#569) |
| L6  | `plan.ts:860`, `plan.ts:916`                                                                                                                                  | `auto:plan-proposed`                                                                 | **Done** (#569) |
| L7  | `plan.ts:1067`, `plan.ts:1071` (`becomeEpic`)                                                                                                                 | The spec's proposed, approved and in-progress labels off (its `auto:epic` is intent) | **Done** (#569) |
| L8  | `plan.ts:1107`, `plan.ts:1112` (`Plan.handToHuman`)                                                                                                           | `auto:needs-human` on the spec, and its proposed and in-progress labels off          | **Done** (#569) |
| L9  | `plan.ts:1050`                                                                                                                                                | A task's `auto:needs-human`, by kind; its `auto:eligible` is intent and stays        | **Done** (#569) |
| L10 | `pull-request.ts:924`                                                                                                                                         | `auto:needs-review`, with no reviewer in the pool                                    | **Done** (#569) |
| L11 | `pull-request.ts:945` (`PullRequest.handToPerson`)                                                                                                            | `auto:needs-human`                                                                   | **Done** (#569) |
| L12 | `pull-request.ts:959` (`PullRequest.readyForPerson`)                                                                                                          | `auto:ready-for-person`                                                              | **Done** (#569) |
| L13 | `stack.ts:753`                                                                                                                                                | `auto:needs-human` on a stack layer whose refresh went to a person                   | **Done** (#569) |

Intent labels are left to people: `auto:eligible`, `auto:plan`, `auto:plan-approved`,
`auto:ship`, `auto:epic` and `hybrid`. Removing one on claim, as `implement.ts:574`,
`:637`, `:715` and `:728` and `hybrid.ts:147` do, acknowledges it and stays. So do the
writes that carry a person's intent forward (amended decision 8): `plan.ts:1050`
labels an approved plan's `auto` tasks `auto:eligible`, `becomeEpic` (`plan.ts:1067`)
labels the spec `auto:epic`, `hybrid.ts:276` labels a pull request a person started
`hybrid`, and `implement.ts:1394` and the epic's open-pull-request copy `auto:ship`
onto the pull request they open.

**Done (#570).** `bun run lint:architecture` runs `scripts/check-world-reads.ts`
(the rule is `scripts/world-reads.ts`, its test `test/world-reads.test.ts`): nothing
in `packages/sdk/src` or `packages/recipes` tests or lists by a status label, or
calls `.read` on a marker but `planNodeMarker`, `followUpMarker` and the epic status
comment's `statusMarker`. Backfill and the projector (`status-labels.ts`) are
exempt, and so are two declarations: the hand-back observer (`Phases.handedBack`),
which reads a person's removal of `auto:needs-human` as their intent, and
`PullRequest.holdKeysOf`, backfill's reader of the merge-hold marker. The rule found
R1 and R2 still open, and they are fixed. The world-sabotage suite runs every
recipe's parks, and its document twin's, on the engine's fakes
(`test/world-sabotage.test.ts`), and implement's through the real CLI in CI jobs
(`test/acceptance/world-sabotage.test.ts`). It deletes, or separately edits, every
status label and comment chernabog wrote, at the park and in the middle of the
phase before it, and checks that the records and the outcome are an untouched
run's and the labels the projection's. A projection that puts `auto:needs-human`
back over a hand-back the observer hasn't recorded yet loses nothing: the observer
reads the removal from the label's events since the with-person record (#573).

Every row of this audit is done. The tables of the backfill below are its
inference rules, not open work.

## Backfill

`chernabog progress backfill --repo <repo>` (`backfill.ts`, run through the
repo's own SDK as `ci plan` runs its `Events`) writes a record for each open
item that needs one and holds none. It infers the phase from the same GitHub
facts the no-record paths read, the one time ADR 21 allows that, and writes it
as `observer:backfill`. It prints what it would write; `--write` writes. Each
write advances from no record, so an item a run recorded since the survey
keeps the run's record, and a second run finds nothing to write. S1
rewrites an issue's `handed-off` record to keep the
author's session beside it, from the version the survey read, so a record a
run wrote since wins the same way. Where the facts don't settle a phase, it
writes nothing and lists the item for a person.

Pull requests: open ones an agent wrote (`auto/` head), a run adopted
(`auto:adopted`), or one of the repo's personas is asked to review or has
reviewed. The first row that matches decides. One labelled `auto:adopted` also
gets `adopted: true` in the record it writes (A1).

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

Every pull request it writes a record for, and every open one that holds a
record keeping no review, also gets the latest review a persona's review
marker names, as `review` in the record's data (`sha`, `reviewer`, `round`,
`verdict`, and the session; the comment's author when the marker names no
reviewer). A record that holds one already gets its phase again with the
review copied in, from that record's version (#564). This is the one read of
`reviewMarker` left in the SDK: since #564 a review writes no marker, and the
merge gate, `latestOwnReview` and `read-review` read the record.

A1: an open pull request labelled `auto:adopted` whose record doesn't say
`adopted` (one adopted before #569) gets its phase again with `adopted: true`
added, from that record's version, or carried in with the review copied in
alongside it. With a person, its hand-off record says it too. From then the
record, not the label, makes it chernabog's (R1, R2).

A pull request labelled `auto:needs-human` is with a person (W1, below)
before any of these rows is read, so P4's label check only matters to one
recorded otherwise. P6 covers changes asked
before a push: `review.round` recorded `changes-asked` then, and nothing moved
it since, so `review.changesRequested` holds it, with why, until the reviewer
is asked again.

With a person, read first, whatever record the item holds (ADR 21, decision
1): this row advances from the record the survey read, by its version, rather
than from none.

| #   | GitHub says                                                                                 | Phase         | Data                                                                    |
| --- | ------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------- |
| W1  | An open issue, pull request or epic labelled `auto:needs-human`, not recorded `with-person` | `with-person` | `why` "labelled auto:needs-human"; `from`, the phase it held, or `null` |

Issues and epics:

| #   | GitHub says                                                                                                              | Phase                                     | Data                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| I1  | `auto:awaiting-ready`, and the latest claim marker adopted a draft                                                       | `awaiting-ready`                          | `pullRequest` from the marker; `withinMillis` 14 days, the recipe's wait                               |
| I2  | `auto:plan-proposed`, and a plan was posted                                                                              | `proposed`                                | `round`, from the latest plan marker; `after`, its comment's id; `plan`, the blob of the tasks it kept |
| I3  | A `proposed` record whose data names no `plan`, and its round's plan marker kept the tasks                               | `proposed` again                          | its data, with `after` and `plan` as I2's, from the record's version                                   |
| —   | `auto:awaiting-ready` with no adopted draft, `auto:plan-proposed` with no plan, or both labels                           | for a person                              |                                                                                                        |
| E1  | `auto:epic`, a task open, and a persona's status comment                                                                 | epic `waiting`                            | the status comment's `fingerprint`; no task attempts kept                                              |
| S1  | An open pull request's persona-written session marker names an issue whose record is `handed-off` with no session for it | `handed-off` again, from the version read | the record's data, with `pullRequest` and `author`, the session                                        |
| S2  | As S1, and the issue has no record                                                                                       | `handed-off`                              | `pullRequest` and `author`, the session                                                                |
| —   | Any other open issue or epic: queued, in progress, or never run                                                          | none                                      | no record is its phase                                                                                 |

What it can't backfill, and leaves to the legacy path or to time:

- A record's `at` is when backfill wrote it, so a backfilled
  `awaiting-ready`, `proposed` or `merge-held` counts its 14-day wait or
  `mergeHoldTimeout` from then, not from when the wait began.
- A backfilled `proposed` or `merge-held` wakes a daemon's run still parked
  in its journal, and a recipe's run takes it up from the record. A
  document's takes up a `proposed` only when it says how long a person has,
  and a `merge-held` only when it names the document's flow, which a
  backfilled one doesn't: a document's run that a CI job left there before
  records stays stranded, as it was. A document's park from before #567,
  whose data says where its run resumed (`resume`), is written again at its
  phase with only its facts, a merge hold with the flow `resume` named; an
  issue's on `awaiting-ci` without its pull request, as the recipe's.
- An epic's backfilled `waiting` keeps no task attempts, as the restart from
  GitHub lost them before (W10).
- A pull request's CI waits (`awaiting-fix-ci`, `awaiting-conflict-ci`,
  `awaiting-merge-ci`) always wrote their record, so none needs a first one.
  One parked on the `awaiting-ci` address-review recorded before #566 is
  moved to `awaiting-fix-ci`, in its round, and an issue's `awaiting-ci`
  that keeps an adopted pull request to `awaiting-adopted-ci`. A
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
   `awaiting-adopted-ci` (#566), whose data keeps the pull request. W7's task CI is: a task's
   lane whose CI is pending ends there, recording the task's
   `awaiting-task-ci`, the epic parks, and a later round takes it up once CI
   settles. So is the stack refresh's: a refresh whose CI is pending ends
   there, the layer and those above it wait, and so does its review
   (`reviewAfterRefresh`); the layer's pull request records
   `awaiting-refresh-ci`, the epic parks, and the next round's `carryUp`
   takes it up first once CI settles, fixing red, asking the reviewer
   again, or giving the layer to a person past `ciTimeout`, and puts the
   review phase it was written over back. No size budget limits either
   (#568). W5 to W10 are done; `hybrid.waitForCi` polls by
   design (W8).
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
