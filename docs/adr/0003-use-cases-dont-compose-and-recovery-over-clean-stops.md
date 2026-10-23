# 3. Use-cases don't compose each other, and recovery over clean stops

Status: accepted, 2026-10-23. Supersedes decision 1 of ADR 2 and amends its
decision 3.

## Context

ADR 2 let a module's use-cases import each other, so the daemon's tick could
start runs, wake waiting ones and record skips by calling those use-cases.
Calling one use-case from another is generally an anti-pattern. The caller
inherits the callee's result shape, so a query reshaped for `status` could
change how many runs a tick launches. The callee's own concerns (logging,
transactions, authorization, when it has them) also nest inside the caller's.

There are three usual ways out:

- **Domain services.** These are stateless functions over aggregates that
  compute new state and touch no repository or port. They can take over a
  composition's _decisions_, never its I/O.
- **Domain events.** An aggregate's state change raises an event, and a
  handler runs the next step, immediately or eventually. This needs an event
  bus and, to survive a crash, an outbox committed with the state change.
- **Sagas, or process managers.** A long-running, stateful coordinator that
  reacts to messages and compensates for failed steps.

A crash is the other question. A CLI or daemon can get a SIGTERM at any
point, and a person who pressed Ctrl-C won't wait long for it to finish.

## Decisions

1. **A use-case never imports another use-case.** `architecture.yaml`
   forbids it. What several use-cases do together, the composition root that
   calls them composes: the daemon, the CLI, the TUI. Tests may still call
   several.
2. **A tick is a plan, applied by its caller.** `planTickUseCase` reads and
   decides what a tick would do: the machine's gates, the trigger, routing
   and the limits. It returns a `TickPlan` and records a skip when it would
   do nothing. The daemon applies the plan. It delivers signals
   (`deliverSignalsUseCase`), then, item by item, asks the flow's gate
   (`gateFlowUseCase`) and starts the run (`startFlowRunUseCase`). This is
   the plan-and-apply split the wizards already use. The gate stays
   per-item because a run just started can close it.

   The plan isn't a separate pure domain service: the domain policy keeps
   each aggregate folder from importing another, and the plan's pure parts
   (`decideTick`, `routeItems`, `freeSlots`, `activeFor`) are already domain
   code.

3. **The tick isn't a saga.** It is one synchronous pass, with no state of its
   own and nothing to compensate. What does resemble a saga in chernabog is a
   run itself, which parks, waits for a signal and resumes. The durable
   workflow engine already models that.
4. **No domain events yet.** Only one step commits a state change and then
   does something outside it. `startFlowRunUseCase` saves the run, executes
   its workflow, then saves the execution. A crash between those saves left a
   run with no execution, which nothing polled and which blocked its item for
   good. An outbox would fix that by keeping the intent next to the state. The
   run row can keep it instead:
   - The run now stores the work item it was started for.
   - At startup, `recoverRunsUseCase` executes every run that has no
     execution, from its item, and attaches the execution.

   Executions are keyed by run id, so a workflow that had already started is
   the one attached, not a second. `test/engine.test.ts` covers both crash
   windows against the SQLite engine. The other multi-step use-cases already
   tolerate a kill: they act at least once, and repeating them is harmless.
   - `deliverSignals` wakes a run before removing its wait.
   - `pollRun` saves an ending only after it has polled the outcome.

5. **Recovery, not clean stops, keeps chernabog correct.** SIGKILL, a closed
   laptop lid or a second Ctrl-C will always skip a graceful stop. So a stop
   is only bookkeeping, and it is bounded. `withShutdownDeadline` gives the
   finalizers 3 seconds after SIGINT or SIGTERM, then exits, and a second
   Ctrl-C exits at once. Before this, `runMain` waited on finalizers with no
   limit and ignored a second signal. Finalizers remove the socket, release
   the lock and write a log line. They never wait for a step to finish.

## Consequences

- The daemon's tick holds more code: one loop over the plan. In return, each
  use-case is one thing an adapter can ask for, testable over its ports'
  fakes. The foreground `chernabog run` already composed these use-cases the
  same way.
- New multi-step work must be recoverable on restart, either repeatable or
  finished by a startup reconciler. Don't rely on a finalizer for it.
- **Revisit domain events and an outbox when a second "commit, then act
  outside" step appears**, or when a step's side effect can't be repeated
  safely. Only the runs module has transactions (SQLite). The machine and
  enrollment modules write JSON, so events there would need a different
  durability story.
- Not yet reviewed for crashes: the apply steps of setup and enrollment. They
  write JSON configuration and register a launchd or systemd service. Check
  them next.
