# 23. Runs execute in spokes, and the daemon is a hub that can end one

Status: accepted, 2026-11-24. Epic [#612](https://github.com/dataquail/chernabog/issues/612)
(#655 to #667). Builds on [ADR 20](0020-flows-run-on-github-actions.md)
(`ci run` runs one item to a phase boundary and exits) and
[ADR 21](0021-one-ledger-the-forge-is-input.md) (the journal is private and
disposable, and every park is a phase boundary). Supersedes the passages of
ADR 10, ADR 20 and ADR 21 that have the daemon run flows in its own process
or resume a run from a journal in `state.db`; each carries a note. Amended
2026-11-25 by #667, once the epic's tasks (#657 to #666) had built it, to
describe the code as it is: each layer recorded where it departed from the
decisions as accepted, and those departures are folded in below, listed at
the end. One question is still the owner's, marked **(open)** in decision 5.

## Context

Every run on a machine executes inside the daemon: one process, one
workflow engine, one `state.db`, which is both the machine's records and the
engine's journal. When a run goes wrong, nothing smaller than the daemon can
be stopped.

#611 shows what that costs. A cancelled epic's workflow replayed in memory
about 90 times a second for 15 hours. It wrote about 112 GB of telemetry and
pushed load averages to 54–135 for every other run, and it came back after
each of five restarts, because its journal resumed it. Cancel couldn't stop
it. A hand edit to `state.db` and a restart did, and the restart interrupted
every run in flight.

Epic #557 made killing a run safe. Every park is a phase boundary (#566), and
run state is out of the epic's record (#568), so a run's journal holds
nothing the ledger doesn't. Losing one costs the current phase, never
correctness (ADR 21, decision 1).

The process that would run one already exists: `chernabog ci run` (ADR 20)
takes one item, takes its claim, runs to the next phase boundary, lets go of
the claim and exits. A job that stops any other way repeats its phase in the
next job. On a machine, the daemon can play the part CI's plan job plays.

So the daemon splits in two:

- The **hub** is the long-lived process that launchd or systemd keeps alive.
  It watches schedules, events and signals, decides what runs, renews the
  claims its spokes hold, and is the only writer of `state.db`.
- A **spoke** is one run. It executes in an OS process of its own, against a
  journal of its own, until its next phase boundary.

A spoke that misbehaves is killed and its journal thrown away. The item
takes up its phase again from the ledger, and every other run carries on.

## Decisions

1. **Processes, not worker threads.** A Bun `Worker` shares its process's
   memory, file descriptors and runtime: a worker in a hot loop starves the
   hub's event loop's neighbours, and one that crashes the runtime takes the
   hub with it. A process can always be killed from outside, can be measured
   by the OS (its resident memory, whether it is alive), and takes only
   itself down when it crashes.

   A spoke is the hub's own executable (`self.ts`), started as a child as
   `ci run --run <run>` (ADR 20's `ci run`, in its spoke form), so a spoke
   always runs the binary the hub runs. It is the leader of a process group
   of its own (spawned detached, `setsid`, `src/platform/process-group.ts`),
   so a signal to the group reaches the spoke and everything it started (a
   headless `claude`, git, the local gate's commands), and a Ctrl-C in the
   terminal that started the hub doesn't reach it. Its stdout and stderr go
   to `daemon.log` as `spoke <run>: …`, for a person; the hub reads nothing
   else from them.

2. **A spoke runs one item to its next phase boundary, then exits.** A
   spoke's life:
   1. The hub's tick plans the item (`PlanTickCommand`, `GateFlowCommand`).
      The hub records the run, with the item it is for, and attaches its
      workflow execution, which is keyed by the run, in one `state.db` unit
      of work (`StartSpokeRunCommand`). Only the dispatch that recorded the
      run starts a spoke, so a run has exactly one, and no run is ever left
      without an execution. The lease checks that need the execution
      (`CheckRunLeasesCommand`) find it in `state.db`.

      The hub writes the run as it recorded it, and its item, to a hand-over
      file (`spokes/<run>.hand-over.json`, a `SpokeHandOver`), then spawns
      the spoke:
      `ci run --run <id> --repo <repo> --flow <flow> [--persona <login>] --item <key> --hand-over-file <path> [--tree <sha>]`,
      with the spoke's byte bounds and stop-after (decision 4). `--tree` is
      the `.chernabog/` tree the hub trusted, so a spoke never runs a tree
      nobody trusted; no `--persona` is the implicit one. The spoke runs
      with its cwd at the checkout, `CHERNABOG_HOME` set to the hub's home,
      `ANTHROPIC_API_KEY` stripped, and a pipe on its stdin that the hub
      holds open. The spoke refuses a hand-over whose run or item isn't the
      one its flags name. The hub records the spoke (decision 7) once it has
      the spoke's PID. If the spawn fails, the run ends `failed`.

   2. The spoke creates its journal (decision 3) and runs the flow
      (`ExecuteRunCommand`, which executes the handed-over run and reads no
      store; it refuses a run no hub attached an execution to, and one whose
      journal already exists). The flow takes the item's claim itself, as
      it did in the daemon (`Implement.claim`, `Claims.acquire`), inside
      the spoke: the hub decides what to start but takes no claim on a
      spoke's behalf, and a claim race the flow loses ends the run as the
      flow says. The spoke renews no lease (decision 6).
   3. The run reaches an ending (`done`, `skipped`, `needs-human`, `failed`,
      `lost`) or parks. A park records its phase and data in the ledger
      first (`Phases.park`, ADR 21) and then ends the run as
      `ended-at-park`; the spoke hears of the park from its own engine
      (`flowLayer`'s `onParked`, once the wait is recorded), never from
      `state.db`. Either way the flow's own wrappers let go of what they
      hold (`Claims.releasing`, `PullRequest.owning`), the spoke writes its
      ending into its journal as its last report (`ReportRunEndedCommand`,
      a `RunEnded` row: a park as `ended-at-park`, running out of time as
      `failed`), and it exits. It ends nothing in `state.db`. The markers
      its ending releases are the hub's to release, after the fold
      (`ReleaseMarkersCommand`). A park keeps the run's markers for the run
      that takes the item up, except its claim refs (`Claims.refMarker`):
      the park lets go of every claim the run holds, its item's and any
      other, such as an epic's (#709). A spoke that stops short of a
      boundary (out of time, a lost lease) lets go of its claims itself.
   4. The hub sees the exit, stops tailing, folds what is left of the
      journal into `state.db` (decision 3), reads the ending
      (`ReadSpokeEndingQuery`) and ends the run with it: `FinishRunCommand`,
      or `CancelRunCommand` `endAs ended-at-park` for a park. The ending's
      reactions release its markers and delete its journal
      (`discard-run-journal`, on `RunFinished`), and the concurrency slot is
      free.

   The hub reads a run's ending from its journal, never from the exit code
   or a signal. A spoke that exits with no ending in its journal (a crash, a
   `SIGKILL` from outside) ends `interrupted`, as a hub's restart ends one
   (decision 7), with the exit code or signal in its reason, through
   `CancelRunCommand` with `closeSessions: true, sparePersonSessions: true`.
   Its phase is left as the ledger has it and its issue goes back on its
   queue, so the next tick's trigger reports the item again and a new spoke
   repeats the phase from its start, as the next CI job does. (As accepted,
   this ended `failed`, which keeps an issue off its queue, so nothing
   repeated the phase; #667 changed it.)

   **A phase that crashes every time stops being repeated.** The run records
   how many runs of its item in a row (same repo, persona, flow and item
   key) have ended this way, itself included (`om_runs.silent_exits`, read
   back by `ReadSilentExitsQuery`, so a hub's restart doesn't reset it; a
   run its hub's restart interrupted is passed over). The run that makes it
   machine config's `spokes: silentExits` (3 by default) ends `failed`
   instead, saying how many in a row, so the item isn't offered again and a
   person sees why (`silentExitEnding`). A run of the item that ends any
   other way, at a phase boundary or otherwise, starts the count again, and
   so does the failed run that reached the limit, so a person who puts the
   item back on its queue gets the full count of tries again. The
   item is its key, so for a flow whose key carries its phase (a review
   loop's `pr-7-changes-asked-1a2b3c4`) the count is per phase, and for one
   whose key doesn't (implement's `issue-7`) per item. The limit and the
   policy are the owner's to change.

   No run sleeps inside a process. When a park's signal arrives (an event, a
   notification, the parked-records watch of ADR 21, decision 4), the source
   that reads the parked phase reports the item as startable, and the hub
   starts a new run, in a new spoke, from the recorded phase. Nothing wakes
   a run in flight: signal delivery is gone (`DeliverSignalsCommand`,
   `WorkflowsClient.wake` and the daemon's poll loop, #665), and the hub
   skips a run with a live spoke when it ends parked runs (`endParked`).
   Waits are still recorded (`om_waits`, `ParkRunCommand`) for `status` and
   `endParked`. The SDK's wake-only sources (`Plan.answers`,
   `PullRequest.baseTurnedGreen`, and `pr.land`'s and `plan.awaitAnswer`'s
   wakes) wake nothing, and are deprecated, not removed, since removing them
   would break `@chernabog/sdk` (#694): what replaces each is a source that
   offers the item from its parked phase record.

   A durable `sleep` inside a phase (a CI poll between readings, a backoff)
   stays inside the spoke and counts against the phase's wall-clock bound
   (decision 4). A poll that sleeps a minute between readings journals each
   reading, so it isn't idle; a single sleep longer than the idle bound
   writes nothing while it lasts and ends the spoke as idle, so a wait that
   long must be a park (ADR 21, decision 4).

3. **A run's journal is its own.** Its shape and its lifetime:
   - **Where:** one SQLite file per run, `journals/<run id>.db` in the
     chernabog home (with SQLite's `-wal` and `-shm` beside it). It's keyed
     by run, and a run has exactly one spoke, so it is also the spoke's.
   - **What:** the workflow engine's tables (`cluster_messages`,
     `cluster_replies`, `cluster_migrations`), and `spoke_reports`, an
     append-only table of what the run tells the machine:
     `(seq INTEGER PRIMARY KEY, at TEXT, tag TEXT, payload TEXT)`. A report
     is one of the commands a run dispatches against `state.db` today,
     encoded with that command's own schema (every runs command already
     crosses JSON, `runs.serializable.test.ts`): `EnterStepCommand`,
     `FinishStepCommand`, `DeclareLaneCommand`, `NameSubjectCommand`,
     `HoldMarkerCommand`, `ForgetMarkerCommand`, `RecordCreatedIssueCommand`,
     `RecordNodeCommand`, `SaveRunPlanCommand`, `RecordTokenUsageCommand` and
     `ParkRunCommand` (`spokeReportCommands`). `EnterStepCommand` and
     `FinishStepCommand` carry the time the spoke stamped (`at`), so a
     folded step keeps when it happened, not when the hub folded it. Two
     reports are new: `AgentSessionOpened` (adapter, session id, the path
     of its `LaunchRecord`, and the transcripts its adapter names,
     `Adapter.transcripts`), written when an agent call starts or resumes a
     session, so the hub can close the session (decision 5) and watch it
     (decision 4); and the spoke's last report, its ending, `RunEnded`
     (`status`, `summary`). Only Claude names its transcripts today (the
     session's file and the folder of its subagents'); Codex finds its
     rollout file only once its thread starts, and opencode and custom
     adapters keep none chernabog knows of. Nothing else goes in a journal.
   - **Who writes it:** only its spoke, created when the spoke starts,
     through a connection of its own beside the engine's
     (`RunRecordsInJournal`, behind the `RunRecords` port that `flowLayer`
     keeps a run's records through). What the spoke needs (the run as the
     hub recorded it, its item) is in the hand-over, and what a run reads
     back within itself (the markers it holds, a session's token cursor) it
     reads from its own reports. Its runs module stands over an empty store
     in memory (`SpokeEngineAt`).
   - **A spoke never writes `state.db`, and reads it at most once.** A
     session's token-usage cursor from an earlier run (`om_usage_cursors`)
     can't be handed over at spawn: which session a call uses is known only
     when the flow makes it (address-review resumes the implementing
     issue's session from a pull request's run). So on a cursor miss in its
     own reports, and only then, the spoke reads that one query from
     `state.db`, through a connection opened lazily `readonly` with
     `PRAGMA query_only = ON` and closed with the spoke (`stateCursors`,
     `run-records.ts`). A `state.db` that is missing or locked reads as a
     session never read.
   - **Who reads it:** the hub, by tailing `spoke_reports` from the last
     `seq` it folded (decision 8). A **fold** dispatches each new report's
     command on the hub's `CommandBus` and advances the run's fold position,
     `om_spokes.folded_seq`, in the same `state.db` transaction
     (`foldInUnitOfWork`, over `RunsModule.unitOfWork`; each command's own
     unit of work joins it as a savepoint), so each report takes effect
     exactly once whatever stops the hub. A report whose command the hub
     refuses rolls back its own savepoint and is logged to the run log and
     skipped, never retried; the position still moves past it. A report the
     hub can't read is skipped the same way. `AgentSessionOpened` is kept on
     the live spoke, not dispatched, and `RunEnded` is read apart.
   - **When it's deleted:** by the hub, after a final fold, when the run
     ends (decision 2, step 4, through `discard-run-journal` on
     `RunFinished`), when it is cancelled (decision 5), when a bound ends it
     (decision 4) and when a restarted hub reaps it (decision 7). A journal
     the hub can't open, such as one a `SIGKILL` left mid-write that SQLite
     can't recover, is deleted unfolded, and the run's reason says so: a
     marker it held is lost to release, as a crash loses a reaction
     (ADR 13). `SweepJournalsCommand` deletes the journal of any run that
     has ended, which covers a reaction a crash lost; the hub runs it after
     the reap, and the foreground `run` at its start.
   - **No process opens another's journal, and nothing resumes from one.**
     `RecoverRunsCommand`'s resume of a workflow is gone, with
     `ResumeRunCommand`, `StartFlowRunCommand` and `RunJournals.open`.
     Within a spoke the engine still journals activities, so a step's retry
     within the process replays, but the journal dies with the spoke.

   `state.db` keeps the machine's own records: runs, steps, lanes, nodes,
   subjects, waits, skips, markers, created issues, plans, usage and
   `om_spokes`. The hub is its only writer, and the engine's tables leave
   it: `state-stamp.ts` drops every `cluster_*` table, after the usual
   backup for an older stamp. The CLI's state-changing commands already go through the daemon (ADR
   17). One that falls back to dispatching itself because no daemon
   answers, such as `cancel` of an ended run, writes `state.db` as it does
   today: with no hub there is no spoke either, so it is still the only
   writer.

   Under GitHub Actions, `ci run` has no hub. There it is both: a spoke that
   writes its journal, and its own hub that folds it into the job's
   throwaway `state.db`, so the code a run executes is the same on a runner
   and on a machine. The foreground `run` and `rehearse` are their own hub
   the same way (decision 9).

4. **The hub bounds every spoke.** Five bounds, each with a default and a
   machine-config override (`spokes:` in `config.yaml`, read by the hub;
   sizes such as `256 MB` and durations such as `4 hours`, and a value that
   doesn't read is a config error naming its key):

   | Bound      | Measured as                                                                            | Default |
   | ---------- | -------------------------------------------------------------------------------------- | ------- |
   | telemetry  | bytes in the spoke's telemetry files, summed over every day folder                     | 256 MB  |
   | run log    | bytes in `runs/<run>.log`                                                              | 32 MB   |
   | phase time | wall-clock time since the hub spawned the spoke                                        | 4 h     |
   | idle       | time since any of the run's files last changed: the journal, the run log, a transcript | 30 min  |
   | memory     | resident memory of the spoke's process group, summed                                   | 2 GB    |

   The defaults sit well above what a healthy run uses (the longest run
   seen is about 2 hours, ADR 20) and far below #611. The spike (#656)
   measured a spoke at about 180–200 MB resident, so the defaults stand.
   The idle bound's journal is its `.db` and `-wal`; its transcripts are
   the ones the spoke's `AgentSessionOpened` reports name (decision 3), so
   a session on an adapter that names none stays out of idle only through
   the journal and the run log, and one working silently for longer than
   the bound is ended.

   **How they are enforced.** The hub samples every live spoke every 5
   seconds (`SAMPLE_EVERY`): telemetry in one pass over the day folders for
   every spoke, the run log's size, the run's files' sizes and times for
   idle, and every group's memory from one `ps -A -o pgid=,rss=`. The first
   bound a spoke is past, in the table's order, is the one it broke
   (`breachOf`). A spoke past a bound is ended through the cancel path
   (decision 5), as `CancelRunCommand` with `endAs failed`, the bound's
   summary and `closeSessions: true`, after a line in `daemon.log` and the
   run's log:
   1. the hub records the ending it intends on the spoke's record
      (`om_spokes.ending`), so a hub that dies mid-kill finishes the same
      way when it restarts (decision 7);
   2. `SIGTERM` to the process group;
   3. after a grace of 10 seconds (`STOP_GRACE`, above a spoke's own
      3-second shutdown deadline, `withShutdownDeadline`), `SIGKILL` to the
      group;
   4. once the spoke has exited and its journal is folded for the last
      time, the journal is deleted and the run ends `failed` ("ended past
      its <bound> bound: <measured> over <limit>; interrupted in <step>");
   5. it cleans up as a cancel does: its agent sessions are closed by their
      handles, always (a session left running would go on spending for a
      run that has ended), its worktrees are removed unless another run in
      flight shares the item, and the issue's claim and branch are let go
      (the branch kept if it holds work). That is what a `failed` ending's
      markers release anyway. The item's phase stays as the ledger has it,
      so a new run repeats it.

   The first ending asked of a spoke holds, so a bound and a cancel at once
   end its run once. A bound's ending that fails is tried again: the hub
   doesn't measure that spoke again until a sample after the first failed
   attempt, then twice as long after each, up to 5 minutes
   (`boundRetryAfter`, `BOUND_RETRY_CAP`), and only the first attempt
   writes to the run's log.

   The hub also passes each spoke `--stop-after-seconds`: its phase-time
   bound plus 5 minutes (`STOP_AFTER_MARGIN`). The hub's bound is the one
   that ends a spoke; the spoke's own stop is a backstop for a hub that has
   stopped watching.

   **Bytes are also capped where they're written.** Sampling every 5
   seconds lets a flood overshoot, and the epic's acceptance criterion is
   that no spoke's telemetry or log grows past its bound on any day. So the
   spoke's own telemetry sink and run-log writer stop writing at the bound
   (a spoke's telemetry files are named for its run,
   `telemetry/<day>/spoke-<run>-<pid>.jsonl`, and the writer counts across
   day folders), and write one last line saying they stopped. The hub's
   kill then ends a spoke that is past the bound and can't say so.

   The spoke learns its byte bounds from flags the hub passes
   (`--telemetry-limit`, `--run-log-limit`, which it provides as
   `RunLogLimit`), not from machine config, and not from the environment:
   flags reach only the spoke, never the agents, gates and tests it starts,
   and an environment variable would leak into a local gate's own
   `chernabog` tests. So a child the spoke starts (a Stop hook, say) writes
   its own `cli-<pid>.jsonl`, which doesn't count toward the spoke's bound.
   The hub's own notes on a run log (that it ends the run's spoke, and the
   ending's note) may follow the log's stop line: a few lines past the
   bound, from the hub, not the spoke.

   Memory is measured, not limited with `rlimit`s: macOS doesn't enforce
   `RLIMIT_RSS`, and `RLIMIT_AS` fails Bun's own reservations.

   An agent session under an interactive launcher (tmux, orca, a person's
   own) runs outside the spoke's process group, so the memory bound doesn't
   count it. It isn't the spoke's memory, and the launcher's own limits are
   the person's.

5. **Cancel kills the spoke.** `chernabog cancel <run>` (`CancelRunCommand`,
   through the daemon, ADR 17), for a run whose spoke is live, asks the
   hub's `RunSpokesClient.end` (which only the hub has; every other process
   answers that no spoke is live) and then:
   1. records the ending it intends on the spoke's record
      (`IntendSpokeEndingCommand`, `om_spokes.ending`): the whole
      `SpokeEndRequest`, who asked (`by`), `closeSessions` and the ending
      (`endAs`, none for `cancelled`). The first ending asked of a spoke is
      its run's: a later, different one waits on the first and is refused
      (`RunAlreadyFinished`), leaving the run to whoever asked first. An
      ending asked before the spoke's record exists is written to the
      record once it does (#667);
   2. sends `SIGTERM` to the process group, then `SIGKILL` after the grace,
      as decision 4 does;
   3. waits for the process to exit (the hub is its parent and reaps it)
      and for the journal's last fold, while the run is still `running`, so
      its last steps and markers land and its ending releases them;
   4. deletes the journal (`WorkflowsClient.discard`);
   5. records the run `cancelled` and clears its waits;
   6. cleans up: the run's worktrees, its claim ref, the issue's claim, and
      its agent sessions (below);
   7. dispatches `RunFinished`, which releases the markers the ending
      releases, and only then answers, saying how the spoke exited
      (`CancelledRun.spokeExited`).

   The ending is recorded before cleanup, not last: a crash during the
   GitHub and launcher calls leaves the run `cancelled`, never `running`.
   What "only then answers" needs holds, since `RunFinished` and the answer
   come last. `lost` and `superseded` take the same path (decision 6) and
   keep their markers.

   **(open) Closing the run's agent sessions.** As accepted, step 6 closed
   them always. The code closes them by the launcher handles they recorded
   (`Launcher.close` on each `LaunchRecord` an `AgentSessionOpened` report
   names; a headless session died with the group) only when asked: a
   person's cancel with `--close-session`, which closes even a session a
   person works in; a bound, always (decision 4); and the reap and the
   foreground takeover, which close an agent's sessions but spare one a
   person works in (decision 7). A person's plain `cancel` leaves them
   open, on purpose: closing a session destroys the person's view of it in
   its launcher's tab. Whether a plain cancel should close them too is the
   owner's to settle; the closing path is built and tested, so changing the
   default is one line.

   The spoke stops on its hub's `SIGTERM` and, on its way out, `SIGKILL`s
   what is left of its group (`killGroupOnStop`, decision 7), so a child
   that ignores `SIGTERM` doesn't outlive a cancelled spoke that exited
   within the grace.

   Cancel returns once the process has exited and its journal is gone, or
   fails saying which step it couldn't finish. A run that has already ended
   is cancelled as before (only its claim ref, `CancelledRun.alreadyEnded`).
   A restarted hub never takes a cancelled run up again: the run is
   `cancelled` and has no journal, and if the hub died between step 1 and
   step 5, reaping finds the intended ending and finishes it (decision 7).

6. **Coordination stays on the ledger.** Spokes on one machine coordinate
   through claims and phase records, as machines and CI jobs already do;
   the hub adds no lock of its own between them. The machine's and each
   repo's `concurrency` count live spokes: a run the hub has recorded whose
   spoke hasn't been reaped. A parked run holds no slot, because it has
   ended.

   **The hub renews the leases**, as the daemon did
   (`CheckRunLeasesCommand`, every `limits.leaseRenewEvery`), for the
   claims each live spoke's reports say it holds: the claim-ref markers
   folded from its `HoldMarkerCommand` reports. It folds each live spoke's
   journal before it checks the leases, so a claim taken since the last
   fold, and taken over since, reads as lost rather than as no claim. A
   spoke doesn't renew its own, so a spoke the hub has stopped watching (a
   hung hub, a hub that died) loses its claim when the lease runs out. A
   claim naming another run ends the spoke as `lost`, through the cancel
   path (`CancelRunCommand` `endAs lost`): the hub records `lost` as its
   intended ending, then signals it as for a bound, and keeps its markers,
   as a lost run does. A run the hub supersedes is ended the same way. `ci
run` under Actions, which has no hub, renews its own lease.

7. **Spokes die with the hub, and their phases repeat.** There is no
   adoption: a hub never takes over a spoke it didn't start.
   - **The spoke record.** `om_spokes` in `state.db` (`RunSpokeRoot`), one
     row per live spoke: run id, PID (which is also its process group), the
     process's start time as `ps` prints it, the hub's PID and start,
     `folded_seq` (which never moves back), and the intended `ending`, a
     `SpokeEndRequest` (none until the hub decides one; the first recorded
     wins). The hub writes it after it spawns the spoke
     (`RecordSpokeCommand`), and an ending asked in between is written to
     it once it exists. A run's ending forgets it (`ForgetSpokeCommand`,
     from the hub's `daemon/spoke-endings` subscription); the position and
     ending commands do nothing once it is gone, so a late fold never
     brings it back.
   - **A spoke dies with its hub.** It watches the pipe on its stdin and,
     when it closes (the hub exited, however it exited), it sends `SIGTERM`
     to its whole process group, itself included, as the hub's own stop
     would. A spoke that stops on `SIGTERM` or `SIGINT`, from its stdin, a
     hub's stop, a cancel or a bound, `SIGKILL`s what is left of its group
     but itself as it exits (`killGroupOnStop`, `src/platform/shutdown.ts`),
     so nothing it started (an agent, git, a local gate's command) outlives
     it, even what ignores `SIGTERM`. A hub that stops cleanly sends
     `SIGTERM` to every spoke's group and closes its stdin before its
     3-second deadline. It waits for none: ending their runs is the next
     hub's job. A spoke too busy to see its stdin close or run a signal
     handler (#611's synchronous hot loop) is what the reap kills.
   - **Reaping on start.** Before anything ends or starts a run, the hub
     reaps every spoke record (`ListSpokesQuery`, `Spokes.reap`, up to 8 at
     once):
     1. If the record's process is still that spoke, the hub sends its
        group `SIGTERM`, then `SIGKILL` after the grace, and polls until the
        group is gone (`endForeignGroup`; the process isn't its child). It
        is that spoke only when the PID's start time is the recorded one
        and its command line holds `--run <run id>` (`processIdentity`,
        `isSpoke`; `ps` gives start times to the second). A reused PID is
        left alone and logged. So is a group whose leader has gone: nothing
        can tell its processes were the spoke's, and a spoke that stopped
        on its stdin took its group with it, so this is only a spoke that
        was itself `SIGKILL`ed or crashed. PIDs 0 and 1 are never signalled.
     2. It folds the journal from the recorded `folded_seq`, in the same
        transaction as a live fold, and collects every `AgentSessionOpened`
        it ever reported. A journal it can't read is deleted unfolded, and
        the run's summary says so.
     3. It ends each run still `running` through `CancelRunCommand`: with
        the intended ending if one was recorded (cancelled, failed past a
        bound, lost), with its own `closeSessions`, and with `interrupted`
        otherwise, `closeSessions: true, sparePersonSessions: true`. A run
        recorded with no spoke record ends `interrupted` too.
        `RunSpokesClient.end` answers for a reaped spoke as for one this hub
        ended, so the journal is discarded and sessions handled as in a
        live cancel.
     4. It forgets every record and removes leftover hand-over files, and
        `SweepJournalsCommand` deletes the journals of runs that have ended.
   - **`interrupted` is a new ending.** Like `ended-at-park` and `lost`, it
     keeps every marker and worktree for the run that takes the item up,
     and lets go of the claim ref so that run may start at once. Like a
     crash, it leaves the phase as the ledger has it, so the next tick
     reports the item again and a new spoke repeats the phase. Two
     exceptions:
     - **The issue is re-queued.** A claim that takes the label that queued
       an issue off it (`Implement.claim`, `Hybrid.claim`, through
       `Implement.takeQueueLabel`) first holds core's `Markers.requeue`,
       only for a label the issue carried. `interrupted` alone releases it
       (`RunMarkerRootOps.keptOn`), which puts the label back, so the
       trigger offers the item again; every other ending keeps it.
     - **The left run's agent sessions are closed**, but never one a person
       works in. The spoke that owned them is dead, so nobody watches them,
       and the run that repeats the phase would work beside them: two
       agents on one item, duplicate pushes, double spend. A session whose
       launch record says `withPerson` stays open, and the ending says so.
       The repeated phase starts its agent call again in a new session;
       whether it should resume the left one instead is the SDK's to
       decide.
   - **The foreground `run` takes over a left run the same way.** A
     foreground `run` that finds its flow's run still running ends it
     `interrupted` (closing an agent's sessions, sparing a person's) once no
     live process owns it, by the PID and start time `om_spokes` keeps
     (`takeOverLeftRun`), and refuses, naming the PID, while one does.
   - **A restart the hub chooses drains first.** An upgraded binary or a
     trusted tree to reload (`ClaimReloadCommand`) stops new spokes and
     restarts the hub once none is live; `status`'s `busy` counts live
     spokes. A
     spoke's phase-time bound caps how long a drain can take. A restart
     nobody chose (a crash, `launchctl kickstart -k`, a reboot) costs every
     live spoke its phase.

8. **The hub tails each spoke's run log and journal. Spokes push
   nothing.** A spoke has no hub client and opens no socket. The hub's view
   of a run comes only from what the spoke has written to disk:
   - the journal's `spoke_reports`, folded into `state.db` as they appear,
     which is where the steps, lanes, nodes, subjects and usage that
     `status`, `/events` and the dashboard show come from, through the same
     queries as today;
   - the run log, which `chernabog logs --follow` and the dashboard already
     read by offset (`FollowRunLogQuery`);
   - the transcripts its `AgentSessionOpened` reports name, only by size,
     so an agent working silently for an hour isn't idle.

   The hub tails on a watch of `journals/`, any change under which wakes
   every live spoke's tail, with a poll behind it every 2 seconds
   (`TAIL_EVERY`; file events can stop on macOS under load, as
   `watchStateChanges` found). A tail folds only when the journal's `.db` or
   `-wal` moved in size or time (`journalSignature`), which no reader moves,
   the hub's own included. The tail, a fold the hub asks for and the final
   fold run one at a time per spoke. The hub also folds a live spoke's
   journal before it ends that run itself (superseded, lost), so the ending
   names the step the spoke was in, and before it checks leases (decision
   6). A fold that changed anything shows up on `/events` as the commands it
   dispatched, on the bus, as a dispatch in the hub would. A spoke that is hung or crashed can't
   misreport its progress, because the hub reads nothing from it but what
   it durably wrote. A hung spoke writes nothing and meets the idle bound;
   one that writes in a loop meets the byte bounds; and the phase-time
   bound holds whatever a spoke writes.

9. **Delete the in-process path.** Once spokes carry every flow, the daemon
   runs no flow itself, and no fallback is kept. The hub keeps what doesn't
   execute a workflow: ticks and triggers (`FlowsClient`), gates, item
   lookups, `stillValid`, marker releases (`ReleaseMarkersCommand`), the
   lease checks and the validity loop. The daemon builds its runtime with no
   flows registered in its engine, and `architecture.yaml`'s
   `hub-runs-no-flow` refuses a call to `flowLayer` or `ExecuteRunCommand`
   under `src/interface/daemon/`.

   The foreground `chernabog run`, `rehearse` and `ci run` under Actions
   execute in a process of their own, each against a journal of its own,
   and are their own hub (`src/interface/cli/own-hub.main.ts`). Each
   records the run with `StartSpokeRunCommand`, records itself as the run's
   spoke (`RecordSpokeCommand`, its own PID and start time), executes it
   with `ExecuteRunCommand` against a journal whose `RunRecords` append to
   `spoke_reports` (`journalRecords`), folds that journal as the hub does
   (`report-fold.server.ts`: `foldSpoke`, `foldInStateDb`, its position in
   `om_spokes`), and ends the run from its boundary as the hub ends a
   spoke's (`endAsSaid`). So a park ends a foreground run too
   (`ended-at-park`), and the command returns rather than wait in the
   process. A hub that starts after one of these died folds the rest of its
   journal exactly once. The SDK's block tests take that path too: a park
   ends the run in their engine as a spoke's does (`ended-at-park`, its
   claims let go by its ending), and a new run takes the item up from what
   the flow's trigger offers from its record (#695).

## Rejected

- **Bun workers, or fibers with a budget.** Neither can be killed from
  outside while it holds the event loop, and #611's loop was synchronous
  replay. A crash in either is the hub's crash.
- **Spokes that outlive the hub, adopted by PID file** (decision 7's other
  option). A restart would leave runs going, but a new hub would have to
  re-attach to processes it didn't start: read their state with no pipe to
  them, trust a PID file over PID reuse, and choose between two versions of
  the code when the restart was an upgrade. Killing them is simpler, and
  decision 3 makes it cheap: a phase repeats, which every CI job already
  survives.
- **Spokes that push events to the hub over the daemon socket** (decision
  8's other option). It is lower latency, but every spoke would need a hub
  client and a protocol versioned with the hub, and progress would be what
  the spoke says rather than what it wrote. A hung spoke can keep sending
  heartbeats from a fiber the hung one doesn't block. The bounds need
  progress a spoke can't fake.
- **Spokes writing `state.db` directly**, with WAL and a busy timeout. That
  makes it many writers on one file again, through the transaction rules of
  ADR 10, and a spoke killed mid-transaction could hold the lock its
  neighbours wait on. The reports table keeps one writer per file.
- **Reading a run's ending from its exit code.** A crash and a deliberate
  `failed` would be told apart only by convention, and an ending's summary
  doesn't fit in a byte. The journal's last report says it, and a missing
  one means the spoke didn't get there.
- **Reusing `failed` for a restart.** `failed` releases the run's markers,
  which would throw away the worktree the repeated phase can use again and
  keep the issue off its queue, and `status` would show a restart as the
  run's own failure.
- **Resuming a spoke's journal after a crash.** It would bring back what
  #611 shows: a run that comes back after every restart. A phase repeats
  instead.
- **`rlimit`s as the bounds.** They are unenforced or unusable for memory on
  macOS (decision 4), and a limit the OS enforces ends a process with no
  record of which bound it broke.

## Consequences

- A run in a hot loop, a hang or a telemetry flood costs at most its phase
  and its bound, never the daemon or another run. The rehearsal (#666)
  proves it, with stand-in flows that spin, hang and flood beside runs that
  finish.
- Every spoke pays its process's start: the runtime, the flow loader and
  the persona's services, built again per run where the daemon kept them
  warm. The spike (#656) measures it with 4 spokes at once, and the hub task
  (#659) sizes startup by it.
- `state.db` gets smaller and has one writer. Engine tables in it from
  before are dropped by a migration (`state-stamp.ts`, #665), after the
  usual backup for an older stamp. A run in flight when a machine upgrades
  to the hub has no spoke record, ends `interrupted` at the hub's first
  start, and repeats its phase.
- A hub restart costs every live spoke its phase, as a CI job's
  cancellation does. That's the price of decision 7, and draining keeps
  chosen restarts from paying it.
- Progress shows up within the tail's latency (at most a couple of seconds),
  not at once. Nothing a person acts on needs it sooner.
- Telemetry and the run log of one run are bounded per run, and the daily
  retention sweeps (`TELEMETRY_RETENTION`, the run-log sweep) still bound
  them overall.
- The engine's journal (ADR 4's durable primitives, journal keys and
  activity names) only matters within one spoke now. Activity names stay
  journal keys within a phase and keep ADR 4's rule (never rename one),
  because a spoke's retry of a step replays by them and `ci run`'s
  answers-by-step file still keys on them.

The epic's tasks built this bottom to top: the journal (#657), `ci run` on
a machine (#658), the hub's spokes (#659), parks (#660), tailing (#661),
cancel (#662), bounds (#663), reaping (#664), deleting the in-process path
(#665), the rogue-run rehearsal (#666) and verification (#667).

## Amendments (#667)

Where the code departed from the decisions as accepted, each layer said so,
and this ADR now describes the code. In brief, by decision:

- **1, 2.** A spoke that exits without saying how its run ended ends
  `interrupted`, not `failed`, so its phase repeats, until `spokes:
silentExits` (3) of its item in a row have, and that one ends `failed`
  (#667). The spoke is `ci run --run` with a hand-over file (#685, #687).
  The hub records the run and attaches its execution in one unit of work
  (`StartSpokeRunCommand`, #685). Signal delivery is gone, and the SDK's
  wake-only sources wake nothing and are deprecated (#696, #694).
- **3.** A spoke reads `state.db` once at most, read-only and `query_only`,
  for a session's token cursor (#687). `AgentSessionOpened` names
  transcripts only for Claude (#688, #689). Steps carry the spoke's time
  (#687).
- **4.** A bound's ending goes through the cancel path and cleans up as a
  cancel does (#689). A failed bound ending backs off (#697). The spoke
  learns its byte bounds from flags, and its children's telemetry doesn't
  count; the hub's notes may follow a run log's stop line (#689). The hub
  passes a stop-after past the phase-time bound (#689).
- **5.** **Open:** sessions close only with `--close-session` (#688), for
  the owner. The ending is recorded before cleanup (#688). An ending asked
  before the spoke's record exists is written to it once it does (#667).
- **6.** The hub folds before checking leases (#688). `lost` and
  `superseded` take the cancel path (#688).
- **7.** Stdin closing signals the whole group, and any stop on a signal
  `SIGKILL`s what is left of it (#690, #667). A group whose leader has gone
  is left alone, and verification checks the command line too (#690). The
  reap and the foreground takeover close a left run's agent sessions but
  never a person's (#696). `interrupted` re-queues the issue (#696).
- **9.** The foreground `run`, `rehearse` and `ci run` under Actions are
  their own hub (#696). `hub-runs-no-flow` keeps the hub from executing a
  flow (#696). The block tests' test-only wake, and `only-tests-wake-runs`,
  are gone: a park ends the run there too, and a new run takes it up
  (#695). A park lets go of every claim ref the run holds by its ending's
  marker release, not only its item's, so a foreground run's epic claim no
  longer outlasts it; `ci run`'s wrap-up lets go of claims only when the job
  stops short of a boundary (#709).
