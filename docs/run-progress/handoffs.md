# Run progress: each recipe's handoffs, and the phases they record

Part of #360, for #362. It maps every point where a run ends or parks and
something later picks the item up. For each one it names the source that
notices it, the block that owns it, and the phase the item is in afterwards.
It then answers the design questions the later tasks build on: #363 (the port),
#364 (the protected-branch adapter), #365 (sources and blocks) and #445 (the
cross-flow check). It changes no behaviour.

The flows are read in two forms:

- **Document versions:** `test/compose-harness.ts`, checked against the
  recipes by `test/compose-scenarios.ts`. Their blocks and sources come from
  `packages/sdk/src/blocks.ts` and the `*-blocks.ts` files beside it.
- **Bundled recipes:** `packages/recipes/flows/*.ts`.

Each recipe's section notes where the two differ in a way that matters here. Paths
without a directory are under `packages/sdk/src/`.

#361's storage measurements weren't available when this was written. The read
costs in [question 6](#6-the-ports-operations) are estimates from the code,
to be replaced with #361's numbers.

## Vocabulary

- **Item:** what a phase is kept for. There are three kinds: an issue
  (`issue-N`), a pull request (`pr-N`) and an epic (`epic-N`). These are the
  names claim refs already use (`packages/core/src/claims.ts:41-43`). See
  [question 4](#4-item-identity).
- **Phase:** the state an item is in once a handoff has happened. The phase is
  only the high-level state: where a run has got to stays local to its
  machine.
- **Fact:** what GitHub says and the run doesn't decide: open, closed or
  merged, the head SHA, CI, `mergeable_state`, review requests and submitted
  reviews.
- **Intent:** what a person says by applying a label: `auto:eligible`,
  `auto:ship`, `auto:plan`, `auto:plan-approved`, `auto:epic` and
  `auto:needs-human`. Intent stays on GitHub.

## The handoffs, recipe by recipe

"Who" says who can cause the handoff: a run, a person, or either. A phase in
_italics_ is recorded but no source reads it. It's for status and the
dashboard, and #445's check allows it: it warns about a phase recorded and
never read only when some source in the catalogue would read it.

### `implement`

Subject `issue` (`blocks.ts:863-904`). Work item `issue-N`
(`implement.ts:71-83`).

| #   | From → to                                    | Item                     | Source, and what it reads today                                                                                                                                                                                                                            | Block                                                                                                 | Who    | Phase                                                                                      |
| --- | -------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| I1  | person or plan or post-merge → implement     | issue                    | `issues.queued` (`blocks.ts:726-760`): open issues labelled `auto:eligible` / `auto:ship`, filtered by the board's Status (`queuedIssuesLabelled`, `src/modules/runs/infrastructure/runtime/sdk-live.ts:310`). Blockers held back (`implement.ts:129-225`) | none: the label is intent                                                                             | either | none                                                                                       |
| I2  | implement → review                           | issue, then its new PR   | `review.requested` (`blocks.ts:762-775`, `review.ts:121-144`): open PRs that request this persona and have no review from it yet (`reviewed === 0`)                                                                                                        | `issue.handOff` (`blocks.ts:542-588`, `implement.ts:1531-1585`)                                       | run    | issue _`handed-off`_; PR `review-asked`                                                    |
| I3  | implement → a person (draft)                 | issue, then its new PR   | none. A person marks the PR ready and asks for review                                                                                                                                                                                                      | `issue.handOff` with a draft from `pr.open` (`DRAFT_DOCUMENT`, `compose-harness.ts:92`)               | run    | issue _`handed-off`_; PR _`draft`_                                                         |
| I4  | implement → a person (ready for person)      | issue, then its new PR   | none                                                                                                                                                                                                                                                       | `pr.readyForPerson` (`re-review-blocks.ts:189-208`, `IMPLEMENT_READY_DOCUMENT`)                       | run    | issue _`handed-off`_; PR _`ready-for-person`_                                              |
| I5  | implement → a person → implement (questions) | issue                    | `issues.queued` again, once a person answers and puts the queue label back (`implement.ts:1118-1146`). Nothing reads `auto:needs-clarification`                                                                                                            | `issue.askClarification` (`blocks.ts:356-385`)                                                        | run    | _`asked-questions`_                                                                        |
| I6  | implement parks → implement (adopted draft)  | issue and adopted PR     | `Implement.readied` (`implement.ts:1613-1638`), contributed as `pr.awaitReady`'s `wakes`: issues labelled `auto:awaiting-ready`, the `adopted` record in the latest claim marker, and `GET /pulls/N` `.draft`                                              | `pr.awaitReady` (`blocks.ts:191-229`, `implement.ts:1598-1606`)                                       | person | issue `awaiting-ready`                                                                     |
| I7  | implement → review (adopted)                 | issue and adopted PR     | `review.requested`, as I2                                                                                                                                                                                                                                  | `issue.handOffAdopted` (`blocks.ts:265-294`)                                                          | run    | issue _`handed-off`_; PR `review-asked`                                                    |
| I8  | implement → a person (any failure)           | issue, and its PR if any | none. A person re-applies the queue label (I1) or removes `auto:needs-human` from the PR                                                                                                                                                                   | the `issue` subject's scope → `Implement.handToHuman` (`blocks.ts:863-904`, `implement.ts:1643-1669`) | run    | none: `auto:needs-human` is a pause, see [question 2](#2-which-blocks-record-which-phases) |

Document vs recipe:

- The recipe calls `Implement.readied` in its own trigger
  (`flows/implement.ts:65`). The document gets the same call as
  `pr.awaitReady`'s `contributes.wakes`.
- Only the document can open a draft (I3) or end with `pr.readyForPerson`
  (I4).

So the phase write belongs inside the SDK functions both forms call
(`Implement.handOff`, `Implement.awaitReady`), not only in the block wrapper.
The TypeScript recipes then record phases too, as the epic says flows on the
escape hatch must.

### `review`

Subject `pull-request` (`blocks.ts:906-925`). Work item `pr-N`.

| #   | From → to                                     | Item | Source, and what it reads today                                                                                                                                                                                                                                       | Block                                                                                                | Who    | Phase                |
| --- | --------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------ | -------------------- |
| R1  | review → address-review                       | PR   | `review.changesRequested` (`address-review-blocks.ts:436-472`): this persona's PRs (`Review.authoredByMe`, `review.ts:677`) without `auto:needs-human`, not owned by a run, whose latest decisive review (`review.ts:689`) is `CHANGES_REQUESTED` on the current head | `review.round`, outcome `changes` (`blocks.ts:590-640`)                                              | either | `changes-asked`      |
| R2  | review → a person merges                      | PR   | none                                                                                                                                                                                                                                                                  | `review.round` `approve` → `pr.land`, which merges nothing without `auto:ship` (`blocks.ts:647-703`) | either | _`approved`_         |
| R3  | review → epic (layer waits)                   | PR   | the epic's own wake (E2). `stack.land` reads the latest decisive review (`stack.ts:478`)                                                                                                                                                                              | `pr.land`, `waitingOnLayer` (`pull-request.ts:818`)                                                  | either | `approved`           |
| R4  | review parks → review (base red)              | PR   | `PullRequest.baseTurnedGreen` (`pull-request.ts:692-735`), contributed as `pr.land`'s `wakes`: open `auto:ship` PRs, the `chernabog-merge-hold` markers in their trusted comments, and `branchCiState(baseRef)`                                                       | `pr.land` → `mergeHolding` / `holdWhileBaseRed` (`pull-request.ts:590-683`)                          | run    | `merge-held`         |
| R5  | review → resolve-conflicts                    | PR   | `pr.conflicting` (C1)                                                                                                                                                                                                                                                 | `pr.land`, merge refused and `conflicts` (`blocks.ts:676-684`)                                       | run    | `approved`           |
| R6  | review → a person (merge refused)             | PR   | none                                                                                                                                                                                                                                                                  | `pr.land` → `PullRequest.handToPerson` (`pull-request.ts:772-781`)                                   | run    | none: a pause        |
| —   | review → a person (approve, `READY_DOCUMENT`) | PR   | none                                                                                                                                                                                                                                                                  | `pr.readyForPerson`                                                                                  | run    | _`ready-for-person`_ |

R1 and R2 are "either" because a person's review causes the same handoff with
no run there to record it: a person requests changes on a PR this persona
wrote, or approves one. See [question 5](#5-handoffs-a-person-causes).

Document vs recipe: the recipe's trigger calls `PullRequest.baseTurnedGreen`
itself (`flows/review.ts:45`). The document gets it from `pr.land`'s `wakes`
(`blocks.ts:698`). The merge logic is the same (`flows/review.ts:76-100`
against `blocks.ts:660-686`).

### `re-review`

Subject `pull-request`. Work item `pr-N-review-K`, where K is this persona's
review count plus one (`re-review-blocks.ts:225`).

| #   | From → to                                 | Item | Source, and what it reads today | Block                                                                              | Who    | Phase                     |
| --- | ----------------------------------------- | ---- | ------------------------------- | ---------------------------------------------------------------------------------- | ------ | ------------------------- |
| RR1 | re-review → a person merges, or merges it | PR   | none, or R3 to R5 as in review  | `review.recheck` `approve` (`re-review-blocks.ts:117-165`) → `pr.land`             | run    | `approved` / `merge-held` |
| RR2 | re-review → a person (still open)         | PR   | none                            | `review.recheck` `changes` → `pr.handToPerson` (`re-review-blocks.ts:167-187`)     | run    | `changes-asked`, paused   |
| RR3 | re-review → a person (rounds exhausted)   | PR   | none                            | `review.roundsLeft` `exhausted` → `pr.handToPerson` (`re-review-blocks.ts:87-115`) | run    | unchanged, paused         |
| RR4 | re-review with no own review → as review  | PR   | as R1 to R6                     | `review.latestOwn` `none` → `review.round` (`re-review-blocks.ts:60-85`)           | either | as review                 |

Re-review is picked up by `review.requestedAgain` (`re-review-blocks.ts:216-233`):
open PRs that request this persona after it has reviewed them
(`reviewed > 0`), without `auto:needs-human`. The handoffs into it are A1 and
C3.

RR2 records `changes-asked` and then pauses. `review.changesRequested`
skips the PR while it carries `auto:needs-human`. When a person removes the
label, the address-review loop goes on as it does today.

Document vs recipe: the steps are the same (`flows/re-review.ts:136-190`).

### `address-review`

Subject `changes-asked` (`address-review-blocks.ts:477-510`). Work item
`pr-N-changes-K`, where K is the count of decisive reviews (`review.ts:700-719`).
The run owns the PR throughout (`PullRequest.owning`, `pull-request.ts:105-122`).

| #   | From → to                                      | Item | Source, and what it reads today                                                                                                                                                            | Block                                                                                          | Who    | Phase                   |
| --- | ---------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------ | ----------------------- |
| A1  | address-review → re-review                     | PR   | `review.requestedAgain` (`re-review-blocks.ts:216-233`, `review.ts:121-144`): open PRs that request this persona and have a review from it, without `auto:needs-human`, not owned by a run | `review.askAgain` (`address-review-blocks.ts:387-431`, `review.ts:857`)                        | either | `review-asked-again`    |
| A2  | address-review → a person (dispute)            | PR   | none                                                                                                                                                                                       | `author.dispute` → `pr.handToPerson`                                                           | run    | `changes-asked`, paused |
| A3  | address-review → a person (questions, failure) | PR   | none                                                                                                                                                                                       | `author.address` `needs-clarification` → `pr.handToPerson`; the subject's scope on any failure | run    | `changes-asked`, paused |

A1 is "either" because a person can ask for a review again without a run,
for instance after pushing a fix of their own.

Document vs recipe: the source is the same (`flows/address-review.ts:35-66`),
and so is `askAgain` (`flows/address-review.ts:122`).

### `resolve-conflicts`

Subject `conflict` (`resolve-conflicts-blocks.ts:541-567`). Work item
`pr-N-<head sha, 7>` (`resolve-conflicts-blocks.ts:524`). The run owns the
PR throughout.

| #   | From → to                                  | Item | Source, and what it reads today                                                                                                                                                | Block                                                                                                            | Who    | Phase                |
| --- | ------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------ | -------------------- |
| C1  | anyone moving the base → resolve-conflicts | PR   | `pr.conflicting` (`resolve-conflicts-blocks.ts:503-534`): this persona's PRs without `auto:needs-human`, not owned by a run, whose `GET /pulls/N` `mergeable_state` is `dirty` | none: a conflict is a fact. `pr.land` (R5) is the one block that says so                                         | either | none                 |
| C2  | resolve-conflicts → CI → whoever waits     | PR   | none: a run of another flow waiting on the PR's CI carries on (`flows/resolve-conflicts.ts:6-8`)                                                                               | `conflict.push`, then `conflict.waitForCi` (`resolve-conflicts-blocks.ts:328-433`)                               | run    | unchanged            |
| C3  | resolve-conflicts → re-review (approved)   | PR   | `review.requestedAgain`: the approver has reviewed already, so it isn't `review.requested`                                                                                     | `conflict.askApproverAgain` (`resolve-conflicts-blocks.ts:435-488`), if the latest decisive review is `APPROVED` | run    | `review-asked-again` |
| C4  | resolve-conflicts → a person               | PR   | none                                                                                                                                                                           | `conflict.resolve` `needs-human` → `pr.handToPerson`; the subject's scope on any failure                         | run    | unchanged, paused    |

C3 goes through re-review's `review.roundsLeft`. An approval that was itself
a re-review, round 2 with the default `reviewRounds: 1`, comes back
`exhausted` and goes to a person rather than being rechecked. That's how it
works today, and it doesn't change here.

Document vs recipe: the document uses `author.worktree` where the recipe calls
`Review.prepareAuthorWorktree` (`flows/resolve-conflicts.ts:292`). The source
is the same (`flows/resolve-conflicts.ts:87-100`).

### `post-merge`

Subject `merged` (`post-merge-blocks.ts:790-826`). Work item `merged-N`
(`post-merge-blocks.ts:766`). It has no claim and no `stillValid`.

| #   | From → to                                   | Item                 | Source, and what it reads today                                                                                                                                                                                                                | Block                                                                                                                                                    | Who    | Phase                     |
| --- | ------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------- |
| P1  | a merge (person, or `pr.land`) → post-merge | PR                   | `pr.mergedRecently` (`post-merge-blocks.ts:727-783`): the 30 closed PRs updated most recently, kept when this persona wrote them, they merged into the flow's base within a day, and no trusted comment carries `chernabog-post-merge-watched` | none: a merge is a fact                                                                                                                                  | either | none                      |
| P2  | post-merge → its next tick (dedupe)         | PR                   | `pr.mergedRecently`, the watched marker                                                                                                                                                                                                        | `merged.markWatched` (`post-merge-blocks.ts:492-517`)                                                                                                    | run    | `watched` (terminal)      |
| P3  | post-merge → implement (red after merge)    | PR, then a new issue | `issues.queued` with `eligible`: the follow-up comes first (`implement.ts:191-193`, `ci.ts:88-97`)                                                                                                                                             | `merged.fileFollowUp` (`post-merge-blocks.ts:622-668`), labelling `auto:eligible`, or `auto:needs-human` when the merged PR was itself a follow-up's fix | run    | none: the label is intent |
| P4  | post-merge → a person (CI timeout)          | PR                   | none                                                                                                                                                                                                                                           | `merged.awaitCi` (`post-merge-blocks.ts:519-558`)                                                                                                        | run    | none                      |

`merged.awaitCi` sleeps durably inside the run, and nothing outside wakes it,
so that wait isn't a handoff.

Document vs recipe: the steps are the same, written inline in the recipe's
`watch()` (`flows/post-merge.ts:497-572`).

### `plan`

Subject `spec` (`plan-blocks.ts:51-85`). Work item `issue-N`.

| #   | From → to                          | Item                             | Source, and what it reads today                                                                                                                                                                                                                 | Block                                                                                                     | Who    | Phase                                      |
| --- | ---------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------ |
| L1  | person → plan                      | issue (spec)                     | `plan.queued` (`plan-blocks.ts:87-101`): open issues labelled `auto:plan`, filtered by the board                                                                                                                                                | none: the label is intent                                                                                 | person | none                                       |
| L2  | plan parks → plan (answer)         | issue (spec)                     | `Plan.answers` (`plan.ts:374-394`), contributed as `plan.awaitAnswer`'s `wakes` (`plan-blocks.ts:201`): issues labelled `auto:plan-proposed`, then `auto:plan-approved` (intent), or else trusted comments after the latest plan marker (facts) | `plan.awaitAnswer` (`plan-blocks.ts:167-202`), after `plan.propose` (`plan-blocks.ts:141`, `plan.ts:548`) | person | `proposed`                                 |
| L3  | plan → implement (task issues)     | the spec, then each task         | `issues.queued` with the labels `plan.create` gives: `auto:eligible`, `auto:needs-human`, or none for hybrid tasks (`plan.ts:576-705`)                                                                                                          | `plan.create` (`plan-blocks.ts:223-247`)                                                                  | run    | none on the tasks: their labels are intent |
| L4  | plan → epic                        | the spec, which becomes the epic | `epic.queued` (E1): `auto:epic`                                                                                                                                                                                                                 | `plan.becomeEpic` (`plan-blocks.ts:249-272`, `plan.ts:717-721`)                                           | run    | spec _`became-epic`_ (terminal)            |
| L5  | plan → a person → plan (questions) | issue (spec)                     | `plan.queued` again, once a person re-applies `auto:plan` (`plan.ts:526-537`)                                                                                                                                                                   | `plan.askClarification` (`plan-blocks.ts:292-312`)                                                        | run    | _`asked-questions`_                        |
| L6  | plan → a person (failure)          | issue (spec)                     | as L5 (`plan.ts:750-768`)                                                                                                                                                                                                                       | the `spec` subject's scope → `Plan.handToHuman`                                                           | run    | none: a pause                              |

The plan holds its claim while it's parked (`flows/plan.ts:119-121`). The
document matches the recipe (`compose-harness.ts:492-551`).

### `epic`

Subject `epic` (`epic-blocks.ts:1198-1217`). The work item is `issue-N`
(`implement.ts:75`, and `EPIC_WORK_ITEM`, `compose-scenarios.ts:2002`), but its
claim is `epic-N` (`claims.ts:43`). Each task layer is a branch
`auto/issue-T` stacked on its blocker's (`epic.ts:205`), and a PR `pr-M`.

| #   | From → to                                        | Item                      | Source, and what it reads today                                                                                                                                                                                                                                                                             | Block                                                                                              | Who    | Phase                                   |
| --- | ------------------------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------ | --------------------------------------- |
| E1  | plan or person → epic                            | epic                      | `epic.queued` (`epic.ts:553-583`): open issues labelled `auto:epic` with an open sub-issue                                                                                                                                                                                                                  | `plan.becomeEpic` (L4), or none when a person applies the label                                    | either | none: the label is intent               |
| E2  | epic parks → epic (a layer changed)              | epic, over all its layers | `epic.queued`: the fingerprint in the persona's latest status comment (`epic.ts:485-542`) against a fresh one (`epic.ts:343-359`), which hashes each sub-issue's state and kind (from its labels) and each layer PR's state, head SHA and review count. No `wakes`: the source itself sends `layer-changed` | `epic.park` (`epic-blocks.ts:1034-1052`)                                                           | either | epic `waiting`                          |
| E3  | epic lane → review                               | task issue, then layer PR | `review.requested`, as I2                                                                                                                                                                                                                                                                                   | `issue.handOff`, after `stack.publish` (`epic-blocks.ts:1081-1137`)                                | run    | issue _`handed-off`_; PR `review-asked` |
| E4  | epic lane → a person → epic (questions)          | task issue                | E2, once a person re-applies the queue label, which changes the task's kind and so the fingerprint                                                                                                                                                                                                          | `issue.askClarification`, then `issue.releaseClaim` (`epic-blocks.ts:1139-1153`)                   | run    | issue _`asked-questions`_               |
| E5  | epic lane → a person → epic (failure)            | task issue and its PR     | as E4                                                                                                                                                                                                                                                                                                       | the `epic.task` lane scope → `handToHuman` (`epic-blocks.ts:1162-1184`), then `epic.recordEndings` | run    | none: a pause                           |
| E6  | `stack.carryUp` / `stack.land` → a person → epic | layer PR                  | E2. Removing `auto:needs-human` from a PR doesn't change the fingerprint, so the run looks again only at the one-day timeout                                                                                                                                                                                | `stack.carryUp` / `stack.land` (`epic-blocks.ts:923-982`)                                          | run    | none: a pause                           |
| E7  | the layer below merged → epic lands this one     | several layer PRs         | E2. `stack.land` reads each layer's latest decisive review (`stack.ts:478`)                                                                                                                                                                                                                                 | `stack.land`, on `auto:ship` only                                                                  | either | PR `approved` read; merged is a fact    |
| E8  | the last task closed → epic wakes and ends       | epic                      | `epic.queued`'s `wakeOnly` item                                                                                                                                                                                                                                                                             | `epic.finished` (`epic-blocks.ts:901-921`, `epic.ts:288`)                                          | either | epic `finished` (terminal)              |

Document vs recipe:

- The recipe hands each layer off with `needsReview: true`
  (`flows/epic.ts:281`). The document's `issue.handOff` asks nobody for a
  draft. Neither opens a draft today, so they behave the same.
- The park timeout is the document's `lookAgainAfter: 1 day` and the recipe's
  `LOOK_AGAIN_AFTER` (`epic.ts:59`).

E6's gap is in both forms. Labels aren't phases, so phases alone don't close
it. Adding the PR's `auto:needs-human` to the fingerprint would, and that's
a follow-up apart from this epic.

### `human-initiated`

Subject `issue`, started by a person with `chernabog start N`
(`Hybrid.itemFor`, `hybrid.ts:60-71`; `blocks.ts:941-942`). It has no source.

| #   | From → to                                       | Item                   | Source, and what it reads today                                                       | Block                                                                       | Who    | Phase                                   |
| --- | ----------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------ | --------------------------------------- |
| H1  | a person → human-initiated                      | issue                  | none: `chernabog start`                                                               | none                                                                        | person | none                                    |
| H2  | session closed before `open-pr` → `start` again | issue                  | none: `start` resumes the issue's session (`hybrid.ts:151-153`, `keepOn: ["failed"]`) | `hybrid.workWithPerson` (`human-initiated-blocks.ts:76-105`)                | person | none: the run's own position, local     |
| H3  | human-initiated → review                        | issue, then its new PR | `review.requested`, as I2. A person merges: never `auto:ship`                         | `hybrid.handOff` (`human-initiated-blocks.ts:244-274`, `hybrid.ts:295-322`) | run    | issue _`handed-off`_; PR `review-asked` |
| H4  | human-initiated → a person (failure)            | issue                  | none                                                                                  | the `issue` subject's scope → `Implement.handToHuman`                       | run    | none: a pause                           |

The document matches the recipe (`compose-harness.ts:438-485`).

## Answers

### 1. The phase set

The phases are kept per kind of item. A flow that works on a pull request
shares that pull request's phases with every other flow that does.

**Shared.** The pull request's review loop is written and read by implement,
human-initiated, the epic's lanes, review, re-review, address-review and
resolve-conflicts:

| Phase                | Meaning                                                                | Recorded by                                                                                                                       | Read by                                   |
| -------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `review-asked`       | Open, and waiting for its first review                                 | `issue.handOff`, `issue.handOffAdopted`, `hybrid.handOff`. A PR with no record is taken to be here                                | `review.requested`                        |
| `changes-asked`      | The latest decisive review asks for changes on the head                | `review.round` `changes`, `review.recheck` `changes`. A person's review is reconciled ([question 5](#5-handoffs-a-person-causes)) | `review.changesRequested`                 |
| `review-asked-again` | Changes made or the base merged in, and a reviewer asked again         | `review.askAgain`, `conflict.askApproverAgain`. A person's request is reconciled                                                  | `review.requestedAgain`                   |
| `approved`           | The latest decisive review approves, and nothing has merged it         | `pr.land` when it doesn't merge (R2, R3, R5). A person's approval is reconciled                                                   | `stack.land`, `conflict.askApproverAgain` |
| `merge-held`         | Approved, `auto:ship`, and a run is parked while the base is red       | `pr.land` (`mergeHolding`)                                                                                                        | `PullRequest.baseTurnedGreen`             |
| _`ready-for-person`_ | Chernabog has done its part, and a person takes the next ordinary step | `pr.readyForPerson`                                                                                                               | none                                      |
| _`draft`_            | Opened as a draft, for a person to mark ready                          | `issue.handOff` with a draft                                                                                                      | none                                      |

The issue's `handed-off` and `asked-questions` are shared too, by implement,
human-initiated and the epic's lanes.

**One flow's own:**

| Item  | Phase            | Flow       | Recorded by          | Read by                           |
| ----- | ---------------- | ---------- | -------------------- | --------------------------------- |
| issue | `awaiting-ready` | implement  | `pr.awaitReady`      | `Implement.readied` (its `wakes`) |
| issue | `proposed`       | plan       | `plan.awaitAnswer`   | `Plan.answers` (its `wakes`)      |
| issue | _`became-epic`_  | plan       | `plan.becomeEpic`    | none                              |
| epic  | `waiting`        | epic       | `epic.park`          | `epic.queued`                     |
| epic  | _`finished`_     | epic       | `epic.finished`      | none                              |
| PR    | `watched`        | post-merge | `merged.markWatched` | `pr.mergedRecently`               |

**Where the constants live.** Proposed: a new `packages/sdk/src/phases.ts`
exporting the names by kind of item, `as const`, with a `Phase` type, on the
precedent of `DEFAULT_LABEL_NAMES` (`settings.ts:90-101`) and
`Plan.LABELS` (`plan-labels.ts:5-8`):

```ts
export const PHASES = {
  issue: {
    handedOff: "handed-off",
    askedQuestions: "asked-questions",
    awaitingReady: "awaiting-ready",
    proposed: "proposed",
    becameEpic: "became-epic",
  },
  pullRequest: {
    reviewAsked: "review-asked",
    changesAsked: "changes-asked",
    reviewAskedAgain: "review-asked-again",
    approved: "approved",
    mergeHeld: "merge-held",
    readyForPerson: "ready-for-person",
    draft: "draft",
    watched: "watched",
  },
  epic: { waiting: "waiting", finished: "finished" },
} as const;
```

Unlike labels, a repo can't rename these: no person reads or applies them, so
there's no reason to. A team's own phases (`progress.advance`, from the epic)
are strings the team chooses. The constants are only the SDK's.

**Not phases:**

- `auto:needs-human` is intent: a person takes the item, and removing the
  label gives it back. Handing to a person records nothing and leaves the
  phase where it was. When the label comes off, the source that reads that
  phase picks the item up again, which is how it works today: RR2 and A2
  return to the review loop, and C4 to `pr.conflicting`.
- A conflict (C1) and a merge (P1) are facts.
- Claims stay as they are.
- A run's own position, such as H2, a lane's attempt, or the epic's loop
  state (`epic-blocks.ts:654-668`), stays on its machine.

### 2. Which blocks record which phases

Most handoffs have exactly one block that owns them. Where they don't:

- **Outcome-dependent, one owner: `pr.land`.** It has no outcomes. It
  returns a summary, and what it leaves behind depends on what happened:
  - merged: nothing to record, since merged is a fact;
  - not merged, and not `auto:ship`, or waiting on a layer, or left to
    resolve-conflicts: `approved`;
  - parked: `merge-held`;
  - refused: a pause.

  It stays the one owner and records the phase inside
  (`PullRequest.mergeHolding`, and the branch before it). Its declaration
  lists both phases it may record (see [question 8](#8-what-the-catalogue-declares)).
  `review.round` and `review.recheck` record nothing on `approve`, because
  `pr.land` always follows an approval on any path that ends well, and a
  document that drops it hands nothing off.

- **Two items at once: `issue.handOff`, `issue.handOffAdopted` and
  `hybrid.handOff`.** Each records the PR's `review-asked` and then the
  issue's `handed-off`, in that order. A crash between the two writes leaves
  the PR findable, and the handoff's activity redoes the issue's write on
  replay. A draft records `draft` in place of `review-asked`.

- **A propose and its park.** `plan.propose` posts the plan, and
  `plan.awaitAnswer` parks. The handoff is the park: a document that proposed
  and then ended would leave an answer nothing waits for. So
  `plan.awaitAnswer` owns `proposed`. On the same reasoning, `pr.awaitReady`
  owns `awaiting-ready` and `epic.park` owns `waiting`.

- **Handoffs to a person are spread** over every block's `person` failures
  and each subject's scope. None of them records a phase, because handing to
  a person is intent on GitHub (see question 1).

- **No block at all:**
  - I1, L1, E1 and H1 start from a person's label or command;
  - C1 and P1 are facts.

  None of these needs a phase.

- **A person's review or request (R1, R2, A1):** the source reconciles it.
  See question 5.

As question 1 says, the write goes in the SDK function the block calls, so the
recipes in `packages/recipes/flows/` record it too.

### 3. What each source reads

The facts every source keeps reading: open, closed or merged; the head SHA;
CI; `mergeable_state`; requested reviewers; submitted reviews. Every source
keeps the intent labels too, `auto:needs-human` above all. A closed or
merged PR ends its record, whatever the record says. `pr.mergedRecently` is
the one source that reads a PR after it has merged.

| Source                                  | Phases it reads                                | What stays on GitHub                                                                                                                       | What it stops reading                                                                                                               |
| --------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `issues.queued`                         | none                                           | `auto:eligible`, `auto:ship`, the board's Status, blockers                                                                                 | nothing                                                                                                                             |
| `review.requested`                      | PR `review-asked`, or no record                | open, requested reviewers, `auto:needs-human`, the claim ref                                                                               | its review count (`reviewed === 0`, `review.ts:137-141`)                                                                            |
| `review.requestedAgain`                 | PR `review-asked-again`                        | open, requested reviewers, `auto:needs-human`, the claim ref                                                                               | its review count (`reviewed > 0`), and the count in the key (`pr-N-review-K`)                                                       |
| `review.changesRequested`               | PR `changes-asked`                             | open, authored by this persona or adopted, the head SHA, `auto:needs-human`, the claim ref. A person's review is read only to reconcile it | the decisive-review count in the key (`pr-N-changes-K`), and, once reconciled, the reviews of each PR on every tick                 |
| `review.waitingElsewhere`               | as `review.requested`                          | as `review.requested`                                                                                                                      | as `review.requested`                                                                                                               |
| `pr.conflicting`                        | none                                           | `mergeable_state`, the head SHA, `auto:needs-human`, the claim ref                                                                         | nothing. Its key already carries the head                                                                                           |
| `pr.mergedRecently`                     | PR `watched`                                   | closed PRs, merged, its base, author                                                                                                       | the `chernabog-post-merge-watched` comment marker                                                                                   |
| `plan.queued`                           | none                                           | `auto:plan`, the board                                                                                                                     | nothing                                                                                                                             |
| `epic.queued`                           | epic `waiting`; each layer PR's record version | `auto:epic`, sub-issues and their states and kinds, each layer PR's state and head SHA                                                     | the status comment's fingerprint marker, and each layer's review count: a change of review phase changes the layer's record version |
| `Implement.readied` (`wakes`)           | issue `awaiting-ready`                         | the adopted PR's `draft`                                                                                                                   | the `auto:awaiting-ready` label as a finder, and the `adopted` record in the claim marker. The label stays for people               |
| `PullRequest.baseTurnedGreen` (`wakes`) | PR `merge-held`                                | `auto:ship`, the base's CI                                                                                                                 | the `chernabog-merge-hold` markers in trusted comments                                                                              |
| `Plan.answers` (`wakes`)                | issue `proposed`                               | `auto:plan-approved` (intent), trusted comments after the plan marker (facts)                                                              | `auto:plan-proposed` as a finder. The label stays for people                                                                        |

The labels a run applies for people to read (`auto:in-progress`,
`auto:awaiting-ready`, `auto:plan-proposed`, `auto:needs-review` and the
rest) stay. They're how a person sees progress on GitHub. They stop being
what a source decides by.

Where the work item's key came from a count (`pr-N-changes-K`,
`pr-N-review-K`), it comes from the record instead: the item, the phase, and
the record's version shortened as a head SHA is (`pr-7-changes-asked-1a2b3c4`).
A new record is new work, the way `pr.conflicting`'s key already treats a new
head. The key format isn't part of the port. It's the SDK's, as now, so
changing it needs no migration beyond letting runs in flight finish under
their old keys.

### 4. Item identity

A phase attaches to the item a handoff is keyed on. The SDK names that item
with the names claims already use, `Claims.issue`, `Claims.pullRequest` and
`Claims.epic` (`packages/core/src/claims.ts:41-43`), and the branch is
`chernabog/threads/<item>`, as the epic decides:

| Subject (`blocks.ts:856-925`)                         | Item kind | Branch                       |
| ----------------------------------------------------- | --------- | ---------------------------- |
| `issue`, `spec`                                       | issue     | `chernabog/threads/issue-12` |
| `pull-request`, `changes-asked`, `conflict`, `merged` | PR        | `chernabog/threads/pr-73`    |
| `epic`                                                | epic      | `chernabog/threads/epic-40`  |

- **The subjects are views, not items.** Four subjects are the same pull
  request, seen by different flows. That's why their phases are shared.
- **An issue becoming a PR is two items.** The issue's thread ends at
  `handed-off`, and the PR's starts at `review-asked`, both in the hand-off
  block (question 2). Later handoffs are the PR's. The PR's body (`Closes
#N`) and the issue's session marker already link them, so the record
  needn't.
- **A spec becoming an epic is two items on one number.** The spec's thread
  is `issue-40` and ends `became-epic`. The epic's is `epic-40`, matching its
  claim rather than its work item key (`issue-40`), which is the one place
  those two disagree today.
- **An epic spans stacked PRs, and doesn't own their phases.** Each layer
  is its own PR item, which the review flows advance as they would any PR.
  The epic's own record is only `waiting` and `finished`. Its wake (E2) reads
  its layers' record versions in place of their review counts.
- **The adapter must keep item names opaque.** A hosted backend can map
  them as it likes. Only the protected-branch adapter (#364) turns
  `pr-73` into `chernabog/threads/pr-73`.

### 5. Handoffs a person causes

Today R1, R2 and A1 work just as well when a person causes them: a person
requests changes on a PR a persona wrote, or approves it, or asks a persona to
review again. No run is there to record the phase, so this design has two
ways it could go:

- **The run that picks the item up records the phase as it starts.** The
  source has already chosen the item, and its key, by then. So it would
  still decide from reviews and counts, and the phase would record a decision
  after it was made. Rejected.
- **The source that notices the fact advances the record.** This is the
  recommended way: a **reconciling source**. When a source reads a fact
  that proves a later phase than the record holds, it advances the record
  before it reports the item. Its sole condition is that the record still
  holds what it read: the port's compare-and-set. Examples:
  - a `CHANGES_REQUESTED` review on the head, while the record is
    `review-asked`, `review-asked-again` or `approved`, gives
    `changes-asked`;
  - an `APPROVED` review gives `approved`;
  - a review requested of a reviewer who reviewed already, while the record
    is `changes-asked` or `approved`, gives `review-asked-again`.

What this adds to the port's contract (#363):

- **`advance` needs no claim.** Claims fence a run's work, and the
  compare-and-set fences the record. Two daemons that notice one review both
  try the same advance: one wins, and the other gets "stale", reads again,
  finds the phase it wanted, and goes on. Advancing is idempotent by phase.
- **It is called outside a run.** That means from a trigger, with the
  persona's token. The adapter can't take a run id from `Run`, so the
  commit says who observed what in its message ("observed review 123 by
  @someone"), not which run.
- **Only the source whose flow picks the item up reconciles it:**
  `review.changesRequested` for `changes-asked`, `review.requestedAgain` for
  `review-asked-again`. `approved` is reconciled by the epic's wake and by
  resolve-conflicts' `conflict.askApproverAgain`, which read it. A source
  never reconciles a phase it doesn't read, which keeps writers few.

This **departs from the epic** as written. The epic says sources read and
handoff blocks record. A reconciling source both reads and writes. That
should be raised on #360 before #363 fixes the port's contract (see "For the
epic" below).

A fact a person can undo, such as a dismissed review or a removed review
request, doesn't move the record back. The next fact moves it on. This is
the point of the epic: a later stray edit on GitHub doesn't rewrite the
item's progress.

### 6. The port's operations

`read` and `advance` aren't enough. Every source looks at every open item on
every tick, so a source built on `read` alone makes one call per item per
source, which is more than today. The proposal is three operations, none of
which knows a phase:

```ts
interface Progress {
  // The item's phase and the record's version, or none.
  read(item: string): Effect<Option<{ phase: string; version: string }>, ProgressError>;
  // Records `phase` if the record is still at `expected` (none: no record yet).
  advance(
    item: string,
    expected: Option<string>,
    phase: string,
    note?: string,
  ): Effect<string /* new version */, Stale | ProgressError>;
  // Every item's current version, in one read.
  versions(): Effect<ReadonlyMap<string, string>, ProgressError>;
}
```

- A version is immutable: a commit, on #364's adapter. So the SDK caches
  `read` by version for the daemon's lifetime, and a tick reads `versions()`
  once and calls `read` only for items whose version changed.
- `versions()` is `git ls-remote` / `matching-refs` on
  `chernabog/threads/` for #364, which #361's question 9 measures.

**Estimate, per persona per tick, from the code as it stands.** The repo is
assumed to have:

- 40 open PRs, 20 of them this persona's and 10 asking it for a review;
- 10 PRs labelled `auto:ship`;
- 30 queued issues;
- 2 epics of 8 tasks each;
- merge holds on;
- every recipe enabled.

| Source                                                         | Calls today                                                                    | Of which phases replace                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `review.requested` and `review.requestedAgain`                 | ~42 (each lists open PRs, then reviews and the claim ref of each requested PR) | ~20 review lists                                              |
| `review.changesRequested`                                      | ~22 (open PRs, then reviews of each authored PR)                               | ~20, reading reviews only for PRs updated since the last tick |
| `pr.conflicting`                                               | ~41 (open PRs, then the claim ref and `GET /pulls/N` of each)                  | none: facts                                                   |
| `baseTurnedGreen` (review's and re-review's)                   | ~24 (open PRs, then trusted comments of each shipping PR, then base CI)        | ~20 comment lists                                             |
| `epic.queued`                                                  | ~39 (sub-issues twice, status comments, then a PR lookup and reviews per task) | ~10 review lists and the status comment                       |
| `issues.queued`, `plan.queued`, the wakes, `pr.mergedRecently` | ~12                                                                            | ~4 marker reads                                               |
| **Total**                                                      | **~180**                                                                       | **~75**                                                       |

With phases, those ~75 calls become one `versions()` call, one or two pages
at this size, plus a `read` per item that changed since the last tick: none
to a handful in steady state. What's left is facts, ~100 calls a tick. Most
of those are the open-PR list read again by every source, and
`pr.conflicting`'s per-PR `GET`. Reading the open-PR list once per tick for
every source would cut far more than phases do. That's a separate change,
worth an issue of its own.

These numbers are estimates. #361 should replace them, and in particular
confirm that a single `matching-refs` call returns every thread.

### 7. Terminal phases

An item is finished when:

- **PR:** closed or merged, a fact, whatever its record says. `watched`
  is the one phase written after a merge, and only `pr.mergedRecently` reads
  it.
- **Issue:** closed. `handed-off` is terminal for the issue's own thread
  while it stays open: its progress goes on as the PR's.
- **Spec:** `became-epic`, or closed.
- **Epic:** `finished`, or closed.

No run writes a "closed" or "merged" phase. Nothing is there when a person
merges or closes, and the fact is enough. A reopened item takes up its
record where it stopped, which is what it should do.

**The branch stays.** The epic makes deletion admin-only, so no run deletes
a thread. An admin's sweep removes threads whose item has been closed or
merged for longer than a retention window. The epic already accepts that
branches pile up unless an admin sweeps them, and the sweep could be listed
by `doctor`. Keeping a `watched` thread past a day buys nothing, since
`pr.mergedRecently` looks back only a day. A 30-day window, the same as run
logs, keeps the record long enough to read. This belongs to #364's setup
work, or a follow-up of it, not to this task.

### 8. What the catalogue declares

These sit beside what a block already declares (`outcomes`, `opens` /
`closes`, `opensOn`, `contributes`; `block.ts:212-272`). Like those, they're
static data, so `chernabog recipes blocks` and the run's plan list them
without running anything.

```ts
// packages/sdk/src/block.ts
type ItemKind = "issue" | "pull-request" | "epic";

// One phase a block may record on its way out.
type Recorded = {
  readonly item: ItemKind;
  readonly phase: Phase; // from PHASES, or a team's own string for progress.advance
  // Recorded only when the block comes to this outcome; left out: on any ending that goes on.
  readonly on?: string;
};

type BlockSpec = {
  // …as now…
  readonly records?: ReadonlyArray<Recorded>;
};

// packages/sdk/src/block.ts, defineSource's static part
type SourceProgress = {
  // The phases whose items it finds. "none" for an item with no record yet.
  readonly reads: ReadonlyArray<{
    readonly item: ItemKind;
    readonly phases: ReadonlyArray<Phase | "none">;
  }>;
  // The phases it reconciles from facts (question 5), each from the phases it moves on from.
  readonly reconciles?: ReadonlyArray<{
    readonly item: ItemKind;
    readonly from: ReadonlyArray<Phase | "none">;
    readonly to: Phase;
  }>;
};

defineSource(name, subject, find, progress);
```

For example:

- `review.round` declares
  `records: [{ item: "pull-request", phase: "changes-asked", on: "changes" }]`;
- `pr.land` declares
  `records: [{ item: "pull-request", phase: "approved" }, { item: "pull-request", phase: "merge-held" }]`,
  with no `on`, because it has no outcomes, and "may record" is what the check
  needs;
- `issue.handOff` declares both its records.

A source that reads a phase has to declare it, and so does a `wakes`
contribution. `wakes` stays inside `contributes`, so it takes a `progress`
next to it, `wakes: { trigger, reads }`, or the block that contributes it
declares `wakeReads`. The first keeps what is read beside the code that reads
it.

#445's check: across the repo's flows, every `(item, phase)` in a source's
`reads` must be produced by a block's `records`, or by a source's
`reconciles`, in some flow. Otherwise it warns. Two cases pass:

- `"none"` is always satisfied, and so is every phase of a reading that
  includes it: `review.requested` takes a pull request a person opened;
- a phase recorded and never read is allowed, as the italic phases above are.

As built (#445), the check also warns about a phase recorded in some flow and
read in none where a source in the catalogue would read it: `changes-asked`
recorded by review with no address-review in the repo. A flow without a
document declares nothing, so with one in the repo a gap is reported as a
note it may fill, not a warning. It runs in `chernabog recipes compile`.

## For the epic

Two things here go beyond #360's decisions. A person should raise them there,
since this task commented on no issue.

1. **Reconciling sources write.** The epic says sources read phases and
   handoff blocks record them. A handoff a person causes has no block, so
   this proposes that the source that reads the phase also advances it from
   the fact, with a compare-and-set and no claim
   ([question 5](#5-handoffs-a-person-causes)). That widens who writes, and
   it changes #363's contract: `advance` is called outside a run.
2. **`read` and `advance` need a bulk `versions()`**
   ([question 6](#6-the-ports-operations)). The epic gives "roughly read and
   advance". This adds a third operation, which still knows no phase.

Neither changes "a block that is a handoff records its phase itself". Every
handoff a run makes has exactly one block that owns it.
