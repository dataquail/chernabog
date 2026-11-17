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
   - **Different wakes and hosts.** A daemon is woken by its tick, and a CI
     plan job by an event or the sweep. A daemon runs a phase on a
     person's machine, and a CI job on a runner.
   - **Free movement.** A flow can move between them between any two phases,
     with no special case.

   Two things follow for sources and records:
   - **A parked phase is startable work.** A source that reads a parked phase
     reports an item a run may start, which resumes from the record. It never
     reports only a signal that wakes a run already waiting (`wakeOnly`):
     that run may not exist, because it ended in a CI job or on another
     machine.
   - **A record says when it was written.** A park with a deadline, such as
     14 days for an adopted draft to be marked ready, needs to know how long
     it has waited, and today's record has no time (ADR 20, decision 5).
     `PhaseRecord` gains `at`, the time the adapter wrote it. Adding a field
     to a record is additive to core (ADR 4). On the git adapter it is the
     commit's date.

   A daemon may keep the agent's session warm across a park as an
   optimisation, as `address-review` resumes the author's session today. The
   run itself still ends.

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
- Removing a label or dismissing a review can no longer derail a run
  silently. At worst the item goes to a person as an anomaly or a declared
  intent.
- A team on GitHub Free with a private repo still has an unprotected ledger,
  as ADR 20 notes. Decision 5's checks catch what a ruleset would have
  refused, just later.
- `Items`, the hosted adapter, the local adapter and the ledger config key are
  not built. Decision 6 fixes the direction so that nothing new takes a forge
  object's name as an item id.
