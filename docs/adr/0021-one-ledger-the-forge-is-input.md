# 21. One ledger per repo holds an item's progress; the forge is input and projection

Status: proposed, 2026-11-17. Builds on [ADR 19](0019-run-progress-port.md)
(an item's phase is a record behind a port) and
[ADR 20](0020-flows-run-on-github-actions.md) (a CI job ends at a phase
boundary).

## Context

A flow's state now lives in several places at once. A daemon keeps a run's
position in its durable workflow, in one machine's state.db. A CI job keeps
nothing, so the next job works out where an item is from GitHub. Claims and
phases live in refs on the repo. Labels, review requests and review counts
also say how far an item has got, and anyone with triage access can change
them. The hosted service in the product vision would add one more place,
and Jira or Linear another.

This causes two problems.

- **Two ways to hand off.** On a daemon, a flow may wait inside its run for a
  review, a person or CI, and a tick picks up the next stage. In CI, a run
  records a phase and ends, and an event or the sweep starts the next one
  (ADR 20, decision 5). The same flow behaves differently depending on where
  it runs, and a person reasoning about it has to hold both models.
- **Progress that anyone can rewrite.** ADR 19 began moving progress into an
  explicit record, but sources still read some of it from GitHub. A person
  who removes a label or dismisses a review can move an item backwards or
  sideways in a flow without meaning to.

Third-party services can't fix the second problem by storage alone.
Nothing on GitHub, Jira or Linear can be written only by chernabog and
changed by nobody else:

| Where                                            | Who can change it                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Branches under a ruleset (`chernabog/threads/*`) | Only the bypass list, but a repo admin can edit the ruleset. Private repos on GitHub Free have no rulesets. |
| Custom refs (`refs/chernabog/*`)                 | Anyone who can push: rulesets target only branches and tags.                                                |
| Check runs                                       | Only GitHub Apps can write them, but they belong to a commit, not to an issue.                              |
| Labels, comments, commit statuses                | Anyone with triage or write access.                                                                         |
| Jira issue properties                            | Anyone who can edit the issue, through the API.                                                             |

Only a store chernabog runs itself can keep a record that others can't
change.

## Decisions

1. **Three kinds of state, each with one home.**
   - The **ledger** is coordination: an item's phase, its claim, and which
     run holds it. Only chernabog writes it, through `Progress` and
     `Claims`, by compare-and-set.
   - The **journal** is execution: where a run has got to within one phase,
     its transcripts and its usage. It is private to the machine running it
     and can be lost. Losing it costs time, never correctness.
   - The **world** is everything else: labels, reviews, pull requests, CI
     results, a Jira ticket's status. Anyone may change it. Chernabog reads
     it as input and writes it as projection.

2. **Each repo has exactly one ledger.** The ledger is a port with
   adapters, and a repo's committed config chooses one. Two ledgers are never
   both authoritative for one repo.
   - **Git**, the default: phase threads on protected branches and claim
     refs. It's free, and it comes with a clone.
   - **Hosted**: chernabog's own service. It is the only adapter that can
     refuse writes from anyone but chernabog, and it can hold items that span
     several forges (decision 6).
   - **Local**, for one person with no CI and no other machine. It can't
     coordinate machines, so `doctor` refuses it on a repo with CI flows or
     more than one enrolled machine.

   Today only the git adapter exists. The config key that chooses one comes
   with the second adapter. Moving a repo from one ledger to another is a
   one-way copy, followed by switching the key.

3. **A source reads progress only from the ledger.** A source decides which
   items to start, and from where, from their records. It reads two other
   things from the world, and both are legitimate:
   - **Intent:** what a person asks for (`auto:eligible`, `auto:ship`, a
     review request).
   - **Fact:** what happened (open, merged, the head SHA, a submitted review,
     CI's conclusion).

   A source never treats intent or fact as progress. It doesn't take "no
   review from this persona yet" to mean "review not yet done", or a label
   chernabog applied to mean "parked". A fact a person caused that moves an
   item, such as a review requesting changes, is reconciled into the ledger
   by a source, as ADR 19 decision 8 allows. The record then says what the
   item's phase is.

   A label chernabog applies is a projection, for people to read. A person
   who changes one is giving intent. The flow decides what that intent means,
   such as "stop" or "try again". The change never silently rewinds a
   record.

4. **A wait on a person or another system is a park, wherever a run is.**
   This covers a review, CI, a person marking a draft ready, an answer to
   questions, a merge, and an epic's tasks. To wait, a run records the
   phase, releases its claim and ends, on a daemon as in CI. The next run
   starts from the record. The journal covers only recovery within one
   phase.

   With every wait a park, the daemon and CI do the same thing:
   - **One planner.** It takes the ledger and the world and returns the work
     to start. Daemon ticks and CI's plan job (`ci plan`) both call it.
   - **The same wakes, from different sources.** Both plan again on an event,
     with a scheduled pass behind it for events that are lost. A daemon runs a
     phase on a person's machine, and a CI job on a runner.
   - **Free movement.** A flow can move between them between any two phases,
     with no special case.

   A daemon run that ends at a park doesn't wait for cron to be picked up
   again. Each kind of event already has, or gets, a local source:

   | Event                                         | CI                                      | Daemon                                                                                                                                                                                                                           |
   | --------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | A run records a phase that another flow reads | `repository_dispatch` `chernabog-phase` | A run that ends marks the repo's flows due (`noteLocal`): 3 seconds to settle, at least 30 seconds between event ticks                                                                                                           |
   | Someone on GitHub reviews, labels or comments | The workflow's `on:` events             | The persona's notifications poll                                                                                                                                                                                                 |
   | CI settles on a parked pull request           | `workflow_run: completed`               | **New:** a watch of parked records whose wait is a fact the daemon can poll cheaply, such as a head SHA's checks. It runs at the cadence `waitForCi` polls today (1 minute) and marks the owning flow due when the fact settles. |
   | A person wants it now                         | Re-run the workflow                     | "Run now" in the dashboard, or `chernabog tick`                                                                                                                                                                                  |
   | Any event was lost                            | The scheduled sweep                     | Cron                                                                                                                                                                                                                             |

   With these sources in place, parking costs a daemon a few seconds over
   waiting inside the run. The watch replaces each run's own polling with one
   loop over all parked records. A hosted service could later relay GitHub's
   webhooks to daemons, so a daemon would no longer need to poll.

   Two things follow for sources and records:
   - **A parked phase is startable work.** A source that reads a parked phase
     reports an item a run may start, which resumes from the record. It never
     reports only a signal that wakes a run already waiting (`wakeOnly`):
     that run may not exist, because it ended in a CI job or on another
     machine.
   - **A record says when it was written.** A park with a deadline, such as
     14 days for an adopted draft to be marked ready, needs to know how long
     it has waited, and today's record has no time (ADR 20, decision 5).
     `PhaseRecord` gains `at`, the time the adapter wrote it. On the git
     adapter that is the commit's date, which GitHub sets, not the writer.
   - **A record can carry what the next run needs.** A run that ends at a park
     loses whatever it held in memory: the adopted pull request's number, a
     plan's round, when a merge hold began, an epic's attempts. Today these
     live in comments that anyone can delete. `advance` takes an optional
     `data`, a JSON object of at most 4 KB, and the record returns it. Core
     doesn't interpret it, and the compare-and-set compares phases, not data.
     On the git adapter it is a `Data:` trailer of one-line JSON.

   Both fields are additive to core (ADR 4): a new optional argument and two
   new fields on a returned record.

   A flow document resumes at the node it parked on, found by a **node id the
   record's data names**, not by the phase. One phase can be recorded at
   several nodes: implement's two waits for CI both record `awaiting-ci` on
   the issue. A block that parks (`Block.parks`, in the SDK's `resume.ts`)
   records under `resume`:
   - the document's flow and the node's id;
   - the run's work item and the persona that parked it;
   - `kept`: the outputs of earlier steps that the node and the steps after it
     read. The compiler works out which ones.

   A step whose block runs again (`Block.again`) is run again instead of
   kept. This covers a cheap read, or something that belongs to the machine,
   such as a worktree's path. A step whose output can outgrow the record
   keeps less and reads the rest back (`Block.recall`): `plan.propose` keeps
   its spec and round, and the resumed run reads the plan from the marker on
   its comment, as the recipe does.

   The document's source of parked items (`Resume.parked`) offers the item
   as work a run may start. It holds the item while the node's block says
   the wait hasn't settled, such as CI still pending, and leaves it for the
   persona that parked it. The run starts at the node: it claims the item
   again, restores what was kept, and goes on from the node, so nothing
   before it, such as the agent's work, runs again. A node it no longer has
   holds the item for a person.

   What a node keeps must fit the record. A value that doesn't fit, or that
   JSON can't hold, leaves the block polling inside the run. That is not a
   park, so the run isn't stranded. A node in a repeat's rounds resumes
   there too, in its round, which the record keeps as `round` beside
   `resume` (a plan's `proposed` record has its round there already). The
   resumed run starts the repeat at that round, runs it from the node, and
   runs the rounds after it whole. The repeat's state starts afresh, so the
   compiler takes such a node only when nothing from it on reads the state,
   every `next` sets all of it, and the round can't run off its end; a wait
   anywhere else in the rounds polls, and the epic's rounds start from its
   `waiting` record. A wait in a forEach's lanes polls, except an epic
   task's wait for CI: its lane can't park alone, so it ends, and the
   epic's `waiting` record keeps the task's pending CI (`tasks.ci`: the
   pull request, its round, and `since`). `Epic.queued` offers the epic
   once that CI settles or `ciTimeout` passes, and holds it with why until
   then; a round takes the task up (`Epic.takeUpCi`, `epic.settleCi`),
   hands it off on green, fixes red, and gives it to a person past the
   timeout. An epic's stack refresh (`Stack.refreshLayer`) waits on its
   layer's CI the same way: CI still pending ends the refresh, the layer and
   those above it wait, and so does its review, and the `waiting` record
   keeps it (`layers.ci`: the layer, its pull request, the base and its
   head, the round, `since`, and a few words for the reviewer). The next
   round takes it up first (`Epic.takeUpRefreshes`, in `carryUp`). Those
   refreshes take at most half the record; one past that waits inside the
   run. A flow a person starts has no trigger to offer its item again, so
   its waits poll too, by design: `hybrid.waitForCi` is the one block that
   polls in any document, and polling is not a park, so it strands
   nothing.

   A wait whose record must say both that it is parked and, later, that it
   finished parks on a phase of its own. post-merge's watch of a merge
   commit's push CI first records the pull request `watched` (which both
   triggers take for finished), then, on a first reading still pending,
   `awaiting-merge-ci`, with the merge commit and `since`, when the watch
   began, and a document's `resume` beside them. It is not `awaiting-ci`,
   which address-review records on an open pull request's own CI. The trigger offers it once push CI
   settles, or no run started within `noCiGrace`, or `ciTimeout` passed,
   both counted from `since`, and holds it with why until then. The run
   that takes it up, a different writer, records `watched` again when the
   watch ends. Amending `watched` with more data wouldn't do: `advance` from
   a phase to the same one by the same writer is a retry and keeps the data
   (`Phases.recording`), and `again`, which writes over it, gives the record
   a fresh `at`. That is also why the time the watch began is `since` in the
   data, not the record's `at`: a run that parks again keeps the record it
   found, but a record written afresh would restart the clock.

   A wait on an item whose record another flow reads parks over that
   record and puts it back. resolve-conflicts waits for CI on the merge it
   pushed to an open pull request, whose record holds a review phase, such
   as `review-asked` or `approved`, that review, re-review and
   address-review read. The wait records `awaiting-conflict-ci` (with
   `-2` and on for later rounds, as `awaiting-ci` has) on the pull request,
   and its data keeps `restore`, the phase and data of the record it parked
   over, with `since`, when the round's wait began, and a document's
   `resume`. It is not `awaiting-ci`, which address-review reads as the wait
   on its own fix. The run that takes the wait up records `restore` again
   once the wait ends, however it ends short of a park, so the review phase
   is back; an approval is then asked again, as before. While it is parked
   no other flow's source reads the pull request's phase, much as none did
   while the run that polled owned it, and review holds a review request
   with why. Two other places were weighed and rejected. A separate item
   for the conflict would leave the review phase in place but in view: with
   the claim gone at the park, review and address-review would take the
   pull request up under the pending CI unless every pull-request source
   read a second record. Restoring with nothing in the data would lose
   what the review phase carried, such as a merge hold's `resume`. The
   cost of a restore is a fresh record: a new `at` and version, so a merge
   hold put back counts its time again from there, and a source keyed by
   the record sees new work. One whose record doesn't fit beside the rest
   polls. A pull request with no record goes to a person: every one a run
   opened has a record, backfill gave one to those from before.

   Every wait for CI that parks keeps `since` in its data, when the round's
   wait began, as post-merge's watch does, so `ciTimeout` counts across the
   runs that take it up: a source stops holding the item once it passes,
   and the run that takes it up, finding CI still pending, hands it to a
   person. implement's wait on a pull request it adopted parks on the
   issue's `awaiting-ci` as its wait on one it opened does, and the data
   keeps the pull request, which isn't on the issue's branch.

   A daemon may keep the agent's session warm across a park as an
   optimisation, as `address-review` resumes the author's session today. The
   run itself still ends.

   **A park is always a record.** The daemon ends every run at its park, so
   a park that wrote nothing would strand its item. Three things make one
   impossible:
   - **One way to park.** `Phases.park` takes the wait as a record (its
     step, item, phase and data, which record already there is the same
     wait, and an optional timeout), records it, with `since`, and only
     then parks. A record already there that is the same wait is kept, so
     a run that took the wait up and parks again keeps `since`; one past
     its timeout parks no more. Every wait in the SDK and the recipes parks
     through it: a wait for CI (whose constructors, `parkOnIssue`,
     `parkOnAdopted`, `Review.parkOnPullRequest`, `documentCiWait` and
     `Conflict.waitForCi`'s, each say the item, phase and data for a
     round), an adopted draft, a plan's answer (the recipe's
     `Plan.awaitAnswer` records `proposed` itself now, not `Plan.propose`),
     a merge held for a red base, an epic between rounds and post-merge's
     watch. The architecture rule `no-bare-park` refuses core's
     `awaitSignal` anywhere else in the SDK or a recipe.
   - **No fallback to the world.** A source finds parked work by its record
     alone: `readied` by the record's adopted draft, not the claim marker;
     `heldMerges` by merge-held records, whose `key` is required, not hold
     markers; `pr.mergedRecently` by `watched`, not the
     `post-merge-watched` marker; `review.changesRequested` by its record,
     with no reconcile from none. The claim and owner markers' fallbacks
     for runs from before claim refs are gone too. Backfill is the
     upgrade's migration step instead.
   - **An SDK floor.** The daemon and `ci plan` refuse a repo whose SDK is
     older than this release, one with no `Phases.park`, as they refuse
     one that needs a core they don't provide, and `doctor` says to run
     `chernabog recipes upgrade`.

5. **The ledger is tamper-evident, not tamper-proof.** Every record names its
   writer (ADR 19, decision 5). Before a source acts on a record, it checks
   two things:
   - the writer is one of the repo's personas, a run of one, or a named
     observer;
   - the transition is one the catalogue declares (`Compose.phaseGaps`'s
     declarations, #445).

   A record that fails either check is an anomaly. The item goes to a person
   with the record named, and the source doesn't act on it. This is the
   protection every adapter can give. The hosted adapter adds refusal, which
   no third party offers.

   How it is built:
   - **Where the check lives.** In the SDK's reads, `Phases.records` and
     `Phases.current`, which every source's read goes through, inside a
     trigger that checks (`Blocks.checked`, `ledger-check.ts`). A compiled
     document's trigger is checked by `Blocks.assemble`; each recipe's
     trigger names the document sources and blocks it does the work of,
     such as `Blocks.checked("review.changesRequested", "author.waitForCi")`.
     Not in core's `Progress` port: who the repo's personas are is the
     repo's config, and what a transition means is the SDK's, and core
     gives phases no meaning (ADR 5). A run reads its own item's record
     unchecked: a checked source started it.
   - **Writers.** A run is known by its id's shape, a random UUID, which
     the daemon and `ci run` both mint. A run's id names no persona, so on
     the git adapter "a run of a persona" can't be proved: a person who
     writes a commit with a made-up UUID passes the writer check. That is
     what tamper-evident means here; the hosted adapter, which knows the
     account that wrote, can refuse. A persona is a login of
     `Machine.personas`, compared without case; no code writes as one
     today, but a person repairing a record by hand on that persona's
     account may. An observer is `observer:<source>` for each source that
     declares reconciles, Review's `observer:review.approved`
     (`Review.OBSERVED`), `observer:backfill` (`Backfill.OBSERVED`) and
     `observer:acknowledged`. Any other writer is an anomaly.
   - **Transitions, and how the catalogue reaches a source.** The catalogue
     is the SDK's own declarations, compiled into the SDK the repo pins
     (`Blocks.transitions`), so a source has it at tick time with no
     loading. An observer may record only what it declares: a source's
     reconciles (`to` from each phase it names), backfill's first records
     (from none), an acknowledgement (a phase again, from itself). A run,
     or a persona, may record any SDK phase of its item's kind, and any
     phase that isn't the SDK's. That is because a run's phases come from
     blocks, and recipes record through the same SDK functions, and
     `progress.advance` records whichever phase its document names: so a
     flow document's declaration counts the same as a recipe's, and what
     the catalogue can refuse of a run is a phase of another kind of item,
     such as an epic's `waiting` on a pull request. A team's own phases are
     the repo's to name and no source acts on one, so they pass; so does
     any phase on an item of a team's own. A later round's wait for CI
     (`awaiting-ci-2`) is checked as its first round's. Working the
     catalogue out found two transitions the SDK made and didn't declare:
     address-review's reconcile from `awaiting-ci` to `changes-asked`, now
     in its source's reconciles, and the approval Review finds when it
     takes up a fix's wait, now `Review.OBSERVED`.
   - **How the anomaly reaches a person.** A hold with a reason, which the
     sources already use (`WorkItem.held`), not `auto:needs-human`: a label
     and a comment would be a write per tick unless it remembered what it
     said, and the check must not fail or write in a tick. The read hides
     the anomaly's record from the source, as if there were none, and
     notes it. A source that would write from no record loses the
     compare-and-set to the record that is there, so it writes nothing.
     Every item the trigger reports that the record is about is held, with
     the record named: its item, its version, `from -> phase` and its
     writer, and how to fix it. An anomaly on a phase the flow reads that
     no source reported is reported alone, held, as `<item>-anomaly-<version>`.
     `chernabog status` shows both. A held item starts no run, and the same
     record says the same thing every tick, so nothing repeats. The fix is
     an ordinary record by a known writer, which clears the hold on the
     next tick, or an acknowledgement.
   - **Records from before the check.** Every writer chernabog has written
     as passes, and a phase that isn't the SDK's passes for a run, so a
     removed phase doesn't flood anyone. What remains, such as a renamed
     persona's own write, is listed first by a survey modeled on backfill:
     `chernabog progress anomalies --repo X` lists every record that fails
     the check, as the repo's personas see it, and `--acknowledge` records
     each one's phase again, with its data, as `observer:acknowledged`,
     only if the record is still the one listed. Its `at` was rejected as
     the way to tell old records apart: on the git adapter a pushed
     commit's date is the pusher's to set, so a forged record could
     backdate itself. An allowlist in config was rejected too: it grows
     with every rename, and it is a file anyone with write access edits.
     The acknowledgement lives with backfill under `chernabog progress`,
     not in `doctor`, since doctor reads the world and writes nothing.

6. **Items get forge-neutral identities.** Today an item's name is a forge
   object's (`issue-12`, `pr-73`, `epic-4`), and core already treats it as
   opaque (ADR 19, decision 2). From the hosted ledger on:
   - **The ledger mints ids.** An item is a ledger-minted id. It has one or
     more **links** to the world, each `{ system, kind, key }`: a GitHub
     issue `dataquail/chernabog#12`, a pull request, a Jira ticket `PLAT-88`.
   - **A new `Items` port.** It resolves a link to its item, creating it if
     there is none. That step is atomic, like a claim. It also adds a link to
     an item and lists an item's links.
   - **Recipes keep their items for now.** An issue and the pull request that
     implements it stay two items, as today. That one item may link several
     objects is what lets a hosted ledger follow work across GitHub and Jira.
     Merging items is a later decision.
   - **Existing names stay valid.** On the git adapter, `issue-12` and
     `pr-73` remain item ids, since they already are opaque strings. Its
     `Items` adapter resolves a GitHub link to the old name. New kinds of
     item and every item on the hosted adapter get minted ids.
   - **Migration is a copy with renaming.** Moving to the hosted ledger
     copies each thread's latest record and links the old name to its new
     id. Nothing in a flow names a forge object as an item directly once
     sources and blocks go through `Items`.

## Rejected

- **Making third-party state hard to change.** Rulesets, hidden issue
  properties and check runs each protect some state on one forge, against
  some people. None protects an item's progress on every forge, and admins
  can lift all of them.
- **Mirroring the ledger in labels with equal weight.** Two records that can
  disagree need reconciliation rules for every disagreement. Labels are a
  projection that chernabog rewrites from the ledger.
- **Letting a daemon keep waiting inside a run because it can afford to.** A
  daemon pays nothing for a long wait, but a flow that behaves differently on
  a daemon and in CI is the problem this ADR exists to remove. Parking costs
  wake latency. A tick, an event or the sweep pays that.
- **Start-or-wake: a daemon keeps its journal park, and a startable item
  wakes it if it is there.** This is a smaller change, and a daemon could still
  resume mid-phase across a wait. But the parked run keeps its claim on
  `parkedTtl` (`limits.parkedLeaseTtl`, 3 days by default), so a sleeping
  laptop holds the item away from CI and every other machine until the claim
  runs out. That breaks free movement.
- **Keeping forge-shaped item names in the hosted tier.** A name like
  `pr-73` can't say which forge or repo it belongs to. It also can't link a
  Jira ticket to the pull request that closes it.

## Consequences

- Sources that still read progress from the world are violations to fix,
  each in its own change. `docs/run-progress/audit.md` lists them. So are
  in-run waits that don't park on a daemon.
- Three waits break decision 4's first point in CI today: an adopted draft
  marked ready, a plan's answer, and a merge held for a red base. Each parks
  in the run's journal, and its source only wakes the waiting run. A CI job
  ends at the park and throws its journal away, and `ci plan` starts no
  wake-only item, so nothing resumes the item. These are the audit's first
  fixes.
- Once every wait parks, the daemon's durable workflows only cover one
  phase. A daemon restarted mid-phase still resumes from its journal. CI
  can't, and repeats the phase.
- The daemon ends every run that parks, as `ci run` does, not only the parks
  a source can take up from the record. A run that ends there has status
  `ended-at-park`: it keeps every marker, worktree and agent session for the
  run that takes the item up, as a lost run does, and releases its claim ref
  so that run may be on any machine or in CI. That was chosen over ending
  only the parks that can resume, so the daemon and CI behave alike from now
  on. The epic's park (W10) records the epic's `waiting` phase, with what the
  run kept between rounds, and `Epic.queued` offers the epic again only once
  a layer changed since, or a day passed. A flow document's waits for CI
  (audit W8), its wait for a plan's answer (in a repeat's rounds, from the
  spec's `proposed` record) and a merge held by `pr.land` (from the pull
  request's `merge-held` record) park at a node and resume there. Where a
  node can't resume, the wait polls rather than park. The epic document's
  rounds start from the `waiting` record. resolve-conflicts' CI parks on
  `awaiting-conflict-ci` over the pull request's review phase, which the run
  that takes it up puts back (audit W6). No flow document's wait is stranded.
- Removing a label or dismissing a review can no longer derail a run
  silently. At worst the item goes to a person as an anomaly or a declared
  intent.
- A team on GitHub Free with a private repo still has an unprotected ledger,
  as ADR 20 notes. Decision 5's checks catch most of what a ruleset would
  have refused, just later: a record by a writer chernabog doesn't know, an
  observer's transition it doesn't declare, a phase of another kind of
  item. They don't catch a record that copies a run's shape, a UUID, and
  moves an item to a phase of its kind; a ruleset, or the hosted adapter,
  does.
- Every source's reads are checked (decision 5). A record that fails holds
  its item with the record named, in `chernabog status`, until a persona
  records it again or `chernabog progress anomalies --acknowledge` does.
  Upgrading is: run `chernabog progress anomalies`, look at what it lists,
  acknowledge what is right. A repo's own TypeScript flow that doesn't wrap
  its trigger in `Blocks.checked` reads unchecked, as before. A new writer
  outside a run, or a new reconcile, must be declared (a source's
  `reconciles`, or an `OBSERVED` list) or its records hold their items: the
  test suite's Progress fake checks every transition any test makes against
  the catalogue, so a missing declaration fails a test first.
- Open items with no record get one from a single backfill,
  `chernabog progress backfill`. It infers each item's phase from GitHub,
  the one time that inference is allowed, and writes it as
  `observer:backfill`. It is the upgrade's one migration step: the sources'
  no-record paths (audit S6, S7) and every record-or-marker fallback are
  removed, and a binary refuses an SDK from before them. Upgrading a repo
  is: let its runs drain, upgrade the binary (the repo starts nothing until
  its upgrade merges), `recipes upgrade` in a checkout, backfill from it,
  merge.
- `Items`, the hosted adapter, the local adapter and the ledger config key are
  not built; they wait on the hosted service. Decision 6 fixes the direction so that nothing new takes a forge
  object's name as an item id.
