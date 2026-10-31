# 10. Commands declare their unit of work

Status: accepted, 2026-10-31. Issue #289. Supersedes decision 5 of
[ADR 6](0006-use-cases-become-commands-and-queries.md).

## Context

ADR 6 put off the unit of work. The stores commands wrote were JSON and YAML
files, changed under a lock and replaced whole, so there was nothing to open a
transaction over, and `@effect-server-utils/unit-of-work` stayed a dependency
for the runs module's commands to use when they moved onto SQLite.

They have moved, and they used none. A runs command writes several stores in
`state.db` one at a time: `CancelRunCommand` saves the run, then removes its
waits, so a failure between the two leaves a cancelled run still parked. And
the commands dispatch their domain events with no boundary around them, which
in dataquail/functional-domain-driven-hexagon is a defect
(`EventDispatchedOutsideUnitOfWork`): an event that goes out for work that
was then discarded. The event handlers to come need the unit of work's
deferral sink to deliver after commit.

`state.db` is also the workflow engine's journal. Effect's SQLite client is one
connection behind a one-permit semaphore, and a transaction holds that permit
until it ends. While one is open, every other statement in the process waits:
the engine's journal, the daemon's other ticks, the other runs' steps.

## Decisions

1. **Every command declares `withUnitOfWork`**, from
   `@effect-server-utils/unit-of-work`, piped at the end of its handler's
   `Effect.fn`, as the hexagon declares it: not as an inner `uow.run` block.
   Everything it writes commits together, and what it dispatches on the bus
   is handed to the unit of work's sink, so it is delivered once the work has
   committed. `test/unit-of-work.test.ts` checks every command handler names
   it.
2. **`state.db`'s driver is the SQL client's own transaction**
   (`StateDbTransactionDriverLive`, in the runs module's
   `infrastructure/repositories/`). The client is depth-aware: inside a
   transaction it opens a savepoint, so a command dispatched inside another's
   unit of work joins it. `RunsUnitOfWorkLive` builds the unit of work over
   it, beside `RunEventsLive` in `runs.command-handlers.ts`, and `StateAt`
   provides both with the runs' stores.
3. **No transaction spans a call to GitHub, git, a launcher or the engine.**
   One would hold `state.db`'s connection while the engine, which may be what
   it waits on, can't journal. A runs command that calls out (`cancel-run`,
   `check-run-leases`, `deliver-signals`, `gate-flow`, `plan-tick`,
   `poll-run`, `recover-runs`, `release-markers`, `resume-run`,
   `start-flow-run`) declares `withUnitOfWork` around its reads and writes in
   `state.db` only, as blocks between the calls, until the event handlers
   move those calls after commit. `cancel-run` ends the run and clears its
   waits in one unit of work, and only then interrupts its workflow, waits
   for it, removes its worktrees and releases its claims.
4. **The file stores' commands declare it too**, over a driver that opens
   nothing (`FileStoresTransactionDriver`, in `src/platform/unit-of-work.ts`),
   so every command has the same boundary and can dispatch events, and a
   dispatch outside one is a defect everywhere. It gives them no atomicity
   across files: each file is still changed under its lock and replaced
   whole, and a failure leaves the files written before it as they are.
   `main.ts`'s `AppLive` provides `FileStoresUnitOfWork` beside the bus.
5. **A module's dispatcher runs its commands in the unit of work it was built
   beside** (`ownUnitOfWork`, a dispatcher middleware). A handler sees the
   dispatching fiber's context, and the daemon's fiber holds `state.db`'s
   unit of work, so without the pin a file store's command dispatched from
   the daemon (or a rehearsal's, which talks to GitHub) would open a
   `state.db` transaction around it.
6. **`PersistenceUnavailable` is a defect here.** The boundary may fail with
   it, for a store that is momentarily unreachable, but chernabog's stores are
   files on its own machine and have no outage to wait out. Each handler
   demotes it beside its `withUnitOfWork`, so no command's declared failures
   change. A failed commit (`TransactionFailed`) is a defect already.
7. **Handler tests use the library's `PassThroughUnitOfWork`**, which
   `test/events.ts`'s `RecordedEvents` brings with the bus. A test that shows
   what a transaction keeps runs the handler over the live stores in an
   in-memory SQLite, as `cancel-run.handler.test.ts` does.

## Consequences

- A handler that calls out reads in blocks rather than one pipe, until the
  events phase moves the calls into after-commit handlers. Then each declares
  one boundary at its end, like the rest.
- After-commit delivery is in memory. A crash between a commit and its
  reactions loses the reactions; a durable outbox
  (`makeDurableUnitOfWork`) is for when a reaction must not be lost.
- An engine activity that dispatches a runs command opens a short transaction
  of its own. Nothing in one waits on the engine, so it can't deadlock on the
  journal.
