# 23. Runs execute in spokes, and the daemon is a hub that can end one

Status: accepted, 2026-11-24. Epic [#612](https://github.com/dataquail/chernabog/issues/612)
(#655 to #667). Builds on [ADR 20](0020-flows-run-on-github-actions.md)
(`ci run` runs one item to a phase boundary and exits) and
[ADR 21](0021-one-ledger-the-forge-is-input.md) (the journal is private and
disposable, and every park is a phase boundary). Supersedes the passages of
ADR 10, ADR 20 and ADR 21 that have the daemon run flows in its own process
or resume a run from a journal in `state.db`; each carries a note. Where the
code still runs flows in the daemon, this ADR wins and the code is a gap,
closed by the epic's tasks in the order the last paragraph gives.

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

   A spoke is the hub's own executable (`self.ts`), started as a child with
   a subcommand, so a spoke always runs the binary the hub runs. It is the
   leader of a process group of its own (spawned detached, `setsid`), so a
   signal to the group reaches the spoke and everything it started (a
   headless `claude`, git, the local gate's commands), and a Ctrl-C in the
   terminal that started the hub doesn't reach it.

2. **A spoke runs one item to its next phase boundary, then exits.** A
   spoke's life:
   1. The hub's tick plans the item (`PlanTickCommand`, `GateFlowCommand`).
      The hub records the run in `state.db` (`StartRunCommand`, as today),
      with the item it is for, then spawns the spoke with the run's id, the
      repo, flow, persona and item on its command line, and a pipe on the
      spoke's stdin that the hub holds open. It records the spoke
      (decision 7) once it has the spoke's PID. A run's workflow execution
      is keyed by its run, as today, so the hub attaches it
      (`AttachExecutionCommand`) from the run's id without asking the spoke,
      and the lease checks that need it (`CheckRunLeasesCommand`) find it in
      `state.db`.
   2. The spoke creates its journal (decision 3) and runs the flow. The
      flow takes the item's claim itself, as it does today
      (`Implement.claim`, `Claims.acquire`), inside the spoke: the hub
      decides what to start but takes no claim on a spoke's behalf, and a
      claim race the flow loses ends the run as the flow says.
   3. The run reaches an ending (`done`, `skipped`, `needs-human`, `failed`,
      `lost`) or parks. A park records its phase and data in the ledger
      first (`Phases.park`, ADR 21) and then ends the run as
      `ended-at-park`. Either way the flow's own wrappers let go of what
      they hold (`Claims.releasing`, `PullRequest.owning`), the spoke writes
      its ending into its journal as its last report, and it exits. The
      markers its ending releases are the hub's to release, after the fold
      (`ReleaseMarkersCommand`, as today).
   4. The hub sees the exit, folds the journal into `state.db` (decision 3),
      ends the run with the ending the journal reports, deletes the journal,
      and frees the concurrency slot.

   The hub reads a run's ending from its journal, never from the exit code
   or a signal. A spoke that exits with no ending in its journal (a crash, an
   unhandled defect, a `SIGKILL` from outside) ends `failed`, with the exit
   code or signal as its reason. Its phase is left as the ledger has it, so
   the next tick's trigger reports the item again and a new spoke repeats
   the phase from its start, as the next CI job does.

   No run sleeps inside a process. When a park's signal arrives (an event, a
   notification, the parked-records watch of ADR 21, decision 4), the source
   that reads the parked phase reports the item as startable, and the hub
   starts a new run, in a new spoke, from the recorded phase. A spoke in
   flight is never woken: `DeliverSignalsCommand` delivers to no spoke, and
   a signal for an item whose spoke is still running is left for the next
   tick, when the spoke has ended.

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
     `ParkRunCommand`. Two reports are new: `AgentSessionOpened` (adapter,
     session id, the path of its `LaunchRecord` and of its transcript),
     written when an agent call starts or resumes a session, so the hub can
     close the session (decision 5) and watch it (decision 4); and the
     spoke's last report, its ending, `RunEnded` (`status`, `summary`).
     Nothing else goes in a journal.
   - **Who writes it:** only its spoke, created when the spoke starts. A
     spoke never opens `state.db`. What it needs from there (its run's id,
     persona and item) is on its command line, and what a run reads back
     within itself (the markers it holds, say) it reads from its own
     reports.
   - **Who reads it:** the hub, by tailing `spoke_reports` from the last
     `seq` it folded (decision 8). A **fold** dispatches each new report's
     command on the hub's `CommandBus` and advances the run's fold position,
     `om_spokes.folded_seq`, in the same `state.db` transaction, so each
     report takes effect exactly once whatever stops the hub. A report whose
     command the hub refuses is logged to the run log and skipped, never
     retried.
   - **When it's deleted:** by the hub, after a final fold, when the run
     ends (decision 2, step 4), when it is cancelled (decision 5), when a
     bound ends it (decision 4) and when a restarted hub reaps it (decision
     7). A journal the hub can't open, such as one a `SIGKILL` left
     mid-write that SQLite can't recover, is deleted unfolded, and the run's
     reason says so: a marker it held is lost to release, as a crash today
     loses a reaction (ADR 13).
   - **No process opens another's journal, and nothing resumes from one.**
     `RecoverRunsCommand`'s resume of a workflow from `state.db` goes.
     Within a spoke the engine still journals activities, so a step's retry
     within the process replays as it does today, but the journal dies with
     the spoke.

   `state.db` keeps the machine's own records: runs, steps, lanes, nodes,
   subjects, waits, skips, markers, created issues, plans, usage and
   `om_spokes`. The hub is its only writer, and the engine's tables leave
   it. The CLI's state-changing commands already go through the daemon (ADR
   17). One that falls back to dispatching itself because no daemon
   answers, such as `cancel` of an ended run, writes `state.db` as it does
   today: with no hub there is no spoke either, so it is still the only
   writer.

   Under GitHub Actions, `ci run` has no hub. There it is both: a spoke that
   writes its journal, and its own hub that folds it into the job's
   throwaway `state.db`, so the code a run executes is the same on a runner
   and on a machine.

4. **The hub bounds every spoke.** Five bounds, each with a default and a
   machine-config override (`spokes:` in `config.yaml`, read by the hub):

   | Bound      | Measured as                                                                                | Default |
   | ---------- | ------------------------------------------------------------------------------------------ | ------- |
   | telemetry  | bytes in the spoke's telemetry files, summed over every day folder                         | 256 MB  |
   | run log    | bytes in `runs/<run>.log`                                                                  | 32 MB   |
   | phase time | wall-clock time since the spoke started                                                    | 4 h     |
   | idle       | time since any of the run's files last grew: the journal, the run log, an agent transcript | 30 min  |
   | memory     | resident memory of the spoke's process group, summed                                       | 2 GB    |

   The defaults sit well above what a healthy run uses (the longest run
   seen is about 2 hours, ADR 20) and far below #611. The spike (#656)
   measures a spoke's resting memory, and the bounds task (#663) may move a
   default by what it found.

   **How they are enforced.** The hub samples every live spoke every 5
   seconds: file sizes with `stat`, the group's memory with the OS, idle
   and phase time from what it tails. A spoke past a bound is ended:
   1. the hub records the ending it intends on the spoke's record
      (`om_spokes.ending`: `failed`, with the bound, its limit and what it
      measured), so a hub that dies mid-kill finishes the same way when it
      restarts (decision 7);
   2. `SIGTERM` to the process group;
   3. after a grace of 10 seconds (above a spoke's own 3-second shutdown
      deadline, `withShutdownDeadline`), `SIGKILL` to the group;
   4. once the spoke has exited, the fold, then the run ends `failed`
      ("ended past its <bound> bound: <measured> over <limit>"), and its
      journal is deleted. A spoke ended by a bound closes its agent sessions
      as cancel does (decision 5): a session left running would go on
      spending for a run that has ended.

   **Bytes are also capped where they're written.** Sampling every 5
   seconds lets a flood overshoot, and the epic's acceptance criterion is
   that no spoke's telemetry or log grows past its bound on any day. So the
   spoke's own telemetry sink and run-log writer stop writing at the bound
   (a spoke's telemetry files are named for its run,
   `telemetry/<day>/spoke-<run>-<pid>.jsonl`, and the writer counts across
   day folders), and write one last line saying they stopped. The hub's
   kill then ends a spoke that is past the bound and can't say so.

   Memory is measured, not limited with `rlimit`s: macOS doesn't enforce
   `RLIMIT_RSS`, and `RLIMIT_AS` fails Bun's own reservations.

   An agent session under an interactive launcher (tmux, orca, a person's
   own) runs outside the spoke's process group, so the memory bound doesn't
   count it. It isn't the spoke's memory, and the launcher's own limits are
   the person's.

5. **Cancel kills the spoke.** `chernabog cancel <run>` (`CancelRunCommand`,
   through the daemon, ADR 17), for a run whose spoke is live:
   1. records `cancelled` as the spoke's intended ending (`om_spokes.ending`),
      with who asked (`CancelRequest.by`);
   2. sends `SIGTERM` to the process group, then `SIGKILL` after the grace,
      as decision 4 does;
   3. waits for the process to exit (the hub is its parent and reaps it);
   4. folds the journal, then deletes it;
   5. closes the run's agent sessions by the launcher handles they recorded
      (`Launcher.close` on each `LaunchRecord` its `AgentSessionOpened`
      reports name; a headless session died with the group);
   6. releases the run's claim ref and the claims and markers the
      `cancelled` ending releases, as cancel does today;
   7. ends the run `cancelled`, and only then answers.

   Cancel returns once the process has exited and its journal is gone, or
   fails saying which step it couldn't finish. A run that has already ended
   is cancelled as today (only its claim ref, `CancelledRun.alreadyEnded`).
   A restarted hub never takes a cancelled run up again: the run is
   `cancelled` and has no journal, and if the hub died between step 1 and
   step 7, reaping finds the intended ending and finishes it (decision 7).

6. **Coordination stays on the ledger.** Spokes on one machine coordinate
   through claims and phase records, as machines and CI jobs already do;
   the hub adds no lock of its own between them. The machine's and each
   repo's `concurrency` count live spokes: a run the hub has recorded whose
   spoke hasn't been reaped. A parked run holds no slot, because it has
   ended.

   **The hub renews the leases**, as the daemon does today
   (`CheckRunLeasesCommand`, every `limits.leaseRenewEvery`), for the
   claims each live spoke's reports say it holds. A spoke doesn't renew its
   own, so a spoke the hub has stopped watching (a hung hub, a hub that
   died) loses its claim when the lease runs out. A claim naming another
   run ends the spoke as `lost`: the hub records `lost` as its intended
   ending, then signals it as for a bound, and keeps its markers, as a lost
   run does. `ci run` under Actions, which has no hub, renews its own
   lease, as it does today.

7. **Spokes die with the hub, and their phases repeat.** There is no
   adoption: a hub never takes over a spoke it didn't start.
   - **The spoke record.** `om_spokes` in `state.db`, one row per live
     spoke: run id, PID, process group, the process's start time as the OS
     reports it, the hub's PID and start, `folded_seq`, and the intended
     `ending` (none until the hub decides one). The hub writes it after it
     spawns the spoke and deletes it once the run has ended.
   - **A spoke dies with its hub.** It watches the pipe on its stdin and,
     when it closes (the hub exited, however it exited), it stops as on
     `SIGTERM`. A hub that stops cleanly sends `SIGTERM` to every spoke's
     group before its 3-second deadline. It waits for none: ending their
     runs is the next hub's job.
   - **Reaping on start.** Before its first tick, the hub goes through
     every run that is `running` in `state.db`:
     1. If the run has a spoke record whose process is still alive (same
        PID and the same start time, so a reused PID isn't mistaken for
        it), the hub sends its group `SIGTERM`, then `SIGKILL` after the
        grace, and waits until it is gone.
     2. It folds the journal, if there is one, and deletes it.
     3. It ends the run: with the intended ending if one was recorded
        (cancelled, failed past a bound, lost), and with `interrupted`
        otherwise. A run recorded with no spoke record (the hub died between
        recording it and spawning) ends `interrupted` too.
   - **`interrupted` is a new ending.** Like `ended-at-park` and `lost`, it
     keeps every marker, worktree and agent session for the run that takes
     the item up, and lets go of the claim ref so that run may start at
     once. Like a crash, it leaves the phase as the ledger has it, so the
     next tick reports the item again and a new spoke repeats the phase.
   - **A restart the hub chooses drains first.** An upgraded binary or a
     trusted tree to reload (`ClaimReloadCommand`) stops new spokes and
     restarts the hub once none is live, as the daemon drains today. A
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

   The hub tails on a file watch with a poll behind it every 2 seconds
   (file events can stop on macOS under load, as `watchStateChanges` found),
   and a fold that changed anything shows up on `/events` as the commands it
   dispatched, on the bus as today. A spoke that is hung or crashed can't
   misreport its progress, because the hub reads nothing from it but what
   it durably wrote. A hung spoke writes nothing and meets the idle bound;
   one that writes in a loop meets the byte bounds; and the phase-time
   bound holds whatever a spoke writes.

9. **Delete the in-process path.** Once spokes carry every flow, the daemon
   runs no flow itself, and no fallback is kept. The hub keeps what doesn't
   execute a workflow: ticks and triggers (`FlowsClient`), gates, item
   lookups, `stillValid`, marker releases (`ReleaseMarkersCommand`), the
   lease checks and the validity loop. The foreground `chernabog run` and
   `rehearse` already execute in a process of their own. They keep doing so,
   each against a journal of its own, and they are their own hub, as `ci
run` under Actions is.

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
  which would throw away the worktree and session the repeated phase can use
  again, and `status` would show a restart as the run's own failure.
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
  before are dropped by a migration once the in-process path is gone
  (#665), after the usual backup (`state-stamp.ts`). A run in flight when a
  machine upgrades to the hub ends `interrupted` at its first start and
  repeats its phase.
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

The epic's tasks build this bottom to top: the journal (#657), `ci run` on a
machine (#658), the hub's spokes (#659), parks (#660), tailing (#661), cancel
(#662), bounds (#663), reaping (#664), deleting the in-process path (#665),
the rogue-run rehearsal (#666) and verification (#667).
