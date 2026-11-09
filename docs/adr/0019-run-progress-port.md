# 19. An item's phase is a record behind a port in core, with no workflow in it

Status: accepted, 2026-11-09. Epic #360 (#361, #362, #363). Builds on
[ADR 4](0004-core-abi.md) (core only grows) and
[ADR 5](0005-the-engine-knows-no-workflow.md) (the engine knows no workflow).

## Context

Between runs nothing records how far an item has got. A run's own position is
durable and local, and claim refs keep two runs off one item, but each trigger
works out an item's progress from what GitHub shows at that moment: labels,
assignees, review requests, review counts, and work item keys built from those
counts (`pr-N-changes-K`). All of that is easy to change for reasons that have
nothing to do with the flow, and a change can derail work on someone else's
machine.

The epic (#360) settled that progress becomes an explicit record of the
**phase** an item has reached, behind a port in core, implemented first on
protected branches (`chernabog/threads/<item>`, one commit per phase) and
open to a hosted adapter later. #361 tested the storage
(`docs/run-progress/storage-test.md`); #362 mapped every recipe's handoffs to
the sources that read a phase and the blocks that record one
(`docs/run-progress/handoffs.md`). This ADR fixes the port's contract, which
baked flows will depend on.

## Decisions

1. **One port, `Progress`, in core's `services.ts`**, under the key
   `@chernabog/sdk/Progress`, with three members:
   - `read(item)`: the item's `PhaseRecord`, or none;
   - `readAll`: every item's record in one read, since a source looks at
     every open item on every tick. #362 asked for a bulk read of versions;
     #361 found that one GraphQL `refs` query returns each tip with its
     headline, so the bulk read gives whole records and there is no second
     step;
   - `advance(item, { from, to, by })`: moves the item to `to` only if its
     phase is still `from` (none: no record yet), and returns the record it
     wrote.
2. **No workflow knowledge.** Core stores a phase and compares it for
   equality. It has no list of phases, no order and no terminal phase; the
   SDK's phase names (#365) and a team's own are strings to it. An item is an
   opaque name too (`Claims.pullRequest(73)` is `pr-73`); only an adapter maps
   it to its storage.
3. **No git in the contract.** A record is `{ phase, from, by, version }`. The
   version is an opaque string that changes with every record and never
   names another, so a reader can skip what it has seen; on the
   protected-branch adapter it is a commit's oid, but nothing in core says so,
   and no SHA, ref or branch appears in a type.
4. **A defined phase format, validated in core.** `Phase` is a branded schema:
   lowercase letters and digits in words joined by single hyphens, at most 64
   characters (`review-asked`). That fits a commit headline or trailer, a ref
   name, a URL and a database column alike, so a phase that works on one
   backend works on every one. `PhaseWriter`, who makes a transition, is a run
   id, a login or an observer's name: one line, at most 128 characters, no
   spaces. The port's types take only the branded strings, so an adapter
   never sees an unchecked one.
5. **Safe retries: each record names its run and transition.** A run can
   crash after `advance` lands and before its journal records that it did.
   On resume it advances again. An adapter first compares the record the
   item holds with the transition asked for: the same `from`, `to` and `by`
   is the writer's own write, and `advance` returns that record and writes
   nothing. Only then does it compare phases. The same move by another
   writer is a lost race, and so is a retry after someone else moved the item
   on: the record the item holds now is the only one that counts.
6. **Lost races and failures, named for no backend.** A lost race is
   `PhaseMoved { item, expected, found }`, a work error the flow decides on
   (it joins `WorkError`, so an activity's journal keeps it). Anything else
   is `ProgressError`, which a flow can only report (it joins the reported
   errors, so `reportAs` and an activity make it `StepFailed`). Neither is
   `GitHubError`: a hosted adapter fails with the same two. #361 found that
   GitHub reports a lost `createCommitOnBranch` as `STALE_DATA` or as
   `FORBIDDEN`, and a ruleset refusal is likely `FORBIDDEN` too; telling them
   apart, by reading the ref again, is the protected-branch adapter's job
   (#364), not the contract's.
7. **`advance` is a fenced write.** `ProgressCapability` declares it with
   `Capabilities.declare` and joins `CAPABILITIES`, so inside a run the
   engine checks the run's claim before it and reports it after, as
   "recording pr-73 as changes-asked", without naming it. `read` and
   `readAll` are reads.
8. **Writes outside a run are allowed.** #362 proposed that a source that
   sees a fact a person caused (a review requesting changes) reconciles the
   record before it reports the item. That is outside any run: no claim, no
   fence, and no run id. So `by` is an argument, not taken from `Run`, and
   the compare-and-set alone fences the record. Whether sources reconcile is
   #365's to decide on #360; the port allows it either way.
9. **A shared contract suite.** `test/progress-contract.ts` is what every
   adapter must pass, written against the port alone:
   `progressContract(name, makeAdapter)`. The in-memory fake
   (`test/progress-fake.ts`) runs it now; #364 runs it against the
   protected-branch adapter, and a hosted adapter would run it unchanged.
10. **Additive to core.** A new module (`phase.ts`), a new port, two new
    errors, and a wider `WorkError` and reported set: nothing existing
    changes its signature, so this is a minor of core (ADR 4). From the
    release that holds it, the port's members, the record's shape and the
    phase format are fixed for the major: a looser format may come later, a
    stricter one may not.

## Rejected

- **`advance(item, from, to)` with the writer taken from `Run`.** A write
  outside a run (decision 8) has no `Run`, and a contract that reads a
  service the caller may not have would fail at the call, not at compile
  time.
- **Idempotent by phase alone**: treating any record already at `to` as
  success. Then two writers that both moved `review-asked` to `changes-asked`
  would each think it had, and a run could not tell its own write from a
  race it lost. Naming the writer keeps the answer exact; a caller that is
  happy with any writer's `to` reads `found` on `PhaseMoved`.
- **A retry that searches the item's history** for its own transition, past
  the record it holds now. It would need history in the contract, which a
  hosted adapter needn't keep, and the answer it gives is the same: the item
  has moved on, and the run acts on where it is now.
- **Phases as free strings, checked by each adapter.** A phase one backend
  accepts and another refuses would make a flow's correctness depend on its
  storage. A newline, for one, breaks a commit trailer.
- **`GitHubError` on the port**, as the issue's sketch had it. It would tie
  the contract to the first backend.

## Consequences

- Nothing uses the port yet. The binary provides no adapter until #364, and
  #365 adds the SDK's sources and blocks once it does.
- An adapter's correctness is the contract suite's: one that passes it fits
  every flow, and one that fails it doesn't ship.
- The phase format is now part of core's ABI. Loosening it is additive;
  tightening it is a major.
