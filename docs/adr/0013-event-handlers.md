# 13. Side effects outside a command's boundary become event handlers

Status: accepted, 2026-10-31. Issue #290. Brings over the reference
hexagon's `event-handlers/` and `triggers/`, and its inbound event adapters
(`dataquail/functional-domain-driven-hexagon`), and carries out what
[ADR 10](0010-commands-declare-their-unit-of-work.md) left for "the event
handlers to come".

## Context

The runs' commands dispatch `RunStarted`, `RunEnteredStep`,
`RunNeedsAttention`, `RunFinished` and `PullRequestOpened`, and nothing
subscribed. The reactions to a run ending were polled for or chained:

- The daemon released ended runs' markers on a five-second loop, and a
  foreground `run` dispatched `ReleaseMarkersCommand` after its poll loop.
- The daemon diffed `PollRunCommand`'s result to log an ending and note the
  flow for cron, so an ending that cancel, a superseded or lost run, or
  recovery produced was never logged or noted.
- `cancel-run` saves the ending, then interrupts the workflow and waits for
  it, notes the run log, removes worktrees, deletes claim refs, releases the
  issue claim and closes agent sessions.

`state.db` has one connection, and a transaction holds it (ADR 10, decision
3). The unit-of-work library runs each after-commit reaction in a unit of
work of its own: under the runs' unit of work, a fresh `state.db`
transaction around a reaction that reaches GitHub, git or the engine. A
marker's release runs the flow's code against GitHub; interrupting a
workflow and waiting for it would deadlock on the journal it can't write.

## Decisions

1. **The tiers.** A module's `event-handlers/` holds one
   `<verb-noun>.handler.ts` per reaction, exporting one `<verbNoun>Handler`
   that takes the event, with a command's dependency shape (effect, the CQRS
   and unit-of-work libraries, the kernel, its own module's domain and
   ports), and a required `*.handler.test.ts`. `event-handlers/triggers/`
   holds one `<publisher>.triggers.ts` per aggregate whose events they react
   to, registering the subscriptions; the handlers' services come from the
   module that built the triggers, not from the fiber that committed.
   `architecture.yaml` states both, and lets event handlers consume ports
   and root ops as commands do.
2. **After commit, by name.** Each subscription is `subscribeAfterCommit`
   under a stable `{ name }` (`runs/release-run-markers`,
   `daemon/run-endings`). `subscribe`, immediate and inside the publisher's
   transaction, is only for a reaction that must roll its publisher back;
   none does yet.
3. **Reactions run outside any transaction.** The runs' unit of work is
   `UnitOfWorkReactingAfterCommit` (`src/platform/unit-of-work.ts`): the
   library's durable unit of work over an in-memory transport that enqueues
   nothing and, once the publisher's transaction has committed, delivers each
   envelope to its subscription in the committing fiber, outside any
   transaction. A reaction writes `state.db` in a unit of work of its own,
   around its writes alone, as a command that calls out does. The command
   waits for its reactions before it returns, as it did for the in-process
   drain.
4. **A repeat runs nothing twice.** The transport remembers the
   `(eventId, subscription)` pairs it delivered (the last 4096), so a repeat
   of an event, which carries the same `eventId`, reaches each subscription
   once; a failed delivery is forgotten, so a repeat retries it. Each handler
   is also idempotent on its own: a released marker isn't held any more.
5. **Delivery is in process and lossy; the sweeps stay.** A crash between a
   commit and its reactions loses them. `ReleaseMarkersCommand` stays as the
   daemon's sweep, which retries a release that failed and is backing off and
   releases what a lost reaction left held, as the hexagon keeps
   `sweepOutbox`. A durable outbox in `state.db` is for when a reaction must
   not be lost.
6. **An ended run's markers are released on `RunFinished`**
   (`release-run-markers.handler.ts`): newest first, keeping those its
   ending's `keepOn` names, each due marker once. Every ending, polled,
   cancelled, superseded, lost or abandoned by recovery, releases at once. A
   foreground `run` no longer releases after its poll loop; it lists what its
   run left unreleased.
7. **The daemon learns of an ending from `RunFinished`.** An inbound event
   adapter, `src/interface/daemon/run-endings.event-adapter.ts`, subscribes
   the daemon before anything at startup can end a run, reads the run with
   `FindRunQuery`, and hands it to the daemon, which logs the ending and
   notes the flow for cron as the poll loop did. The poll loop only polls.
8. **Cancel keeps its cleanup, and says the run ended last.** Every outcome
   of cancel's cleanup is shown to the person who cancelled
   (`CancelledRun`'s `stopped`, `removedWorktrees`, `releasedClaims`,
   `released`, `closedSessions`, `openSessions`, `leftForPerson`), and a
   handler can't answer its dispatcher. Moving them would mean recording each
   outcome for the CLI to read back, a store of its own for what one command
   already returns. The cleanup is also ordered: the workflow stops before
   its worktrees go and before its claims let another run take the item.
   And `RunFinished` doesn't carry what only cancel knows (`closeSessions`,
   who cancelled), while its endings overlap the poll's (`needs-human`). So
   the cleanup stays in `cancel-run`, outside its unit of work, as ADR 10
   has it, and the run log's note with it, in the same order. What moves
   is when cancel says the run ended: it saves the ending and clears the
   waits in one unit of work, cleans up, and dispatches `RunFinished` in a
   last one, so the markers' release and the daemon's log come after the
   workflow stopped and after the claims cancel reports. A crash between
   the two leaves the markers to the sweep.
9. **No campaign phase.** The issue asked for the `cqrs` campaign's
   `events` phase; that campaign was retired (#273) before this landed, and
   its ledger deleted. The tiers above are enforced by the policy instead,
   which has nothing left to count.

## Consequences

- `RunsModule.events` is the runs' subscriptions, provided over the runs'
  stores and unit of work. `applicationModules.engine` merges it, since it
  reacts to what the engine's commands dispatch and needs the flows the
  process loaded: every root that runs the engine subscribes, on the bus it
  provides.
- The runs' events are declared with `Event.make`, so an aggregate's
  `*.events.ts` names the CQRS library; the daemon's protocol names each
  one's `.schema`.
- An ending now releases its markers inside the committing command's call,
  so `PollRunCommand`, `CancelRunCommand` and `RecoverRunsCommand` take as
  long as the releases, each bounded by the release timeout.
- More candidates, left for follow-ups: `deliver-signals` notes the run log
  and wakes a run after its write; `check-run-leases`, `gate-flow` and
  `start-flow-run` call the engine or GitHub between their writes. The
  dashboard's `/events` stream and a notifier subscribe the same way, as
  `stream` or after-commit consumers.
