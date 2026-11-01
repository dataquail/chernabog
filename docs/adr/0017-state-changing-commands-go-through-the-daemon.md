# 17. State-changing CLI commands go through the daemon first

Status: accepted, 2026-10-31. Issue #326. Generalizes what `start` and
`cancel` already did (`daemonRun`, `daemonCancel`). Builds on the merged
`CommandBus` of [ADR 15](0015-composition-roots.md).

## Context

Every CLI command runs in its own process, with its own event bus (ADR 15,
decision 2), which ends when the command does. `chernabog pause` dispatched
`RepoPaused` on that bus, and the daemon's, the one its event adapters
subscribe to and the dashboard's `/events` stream will read, never heard it.
The daemon learned of the change some other way: `enroll`, `unenroll` and
`trust` asked it to `/reload`, and it read `paused.json` again on its next
tick. Each new listener on the daemon's bus would have had to poll for what a
person changed.

`start` and `cancel` already asked the daemon first and acted in their own
process only when it wasn't running, for a different reason: the daemon holds
the engine. Their routes were written one by one (`/run`, `/cancel`), each
with a protocol type of its own beside the command's.

## Decisions

1. **One route, `POST /commands/:tag`**
   (`src/interface/daemon/daemon-commands.server.ts`). It decodes the body
   with the named command's own payload schema, dispatches it on the daemon's
   merged `CommandBus`, and answers its success encoded with the command's
   success schema, or a `Refusal` (status 422) carrying the error's message,
   its `_tag`, and the error encoded with the command's failure schema. A body
   the payload schema doesn't decode is refused 400. No route or protocol type
   is written per command: a CQRS message already declares its three schemas,
   and each module's serializable test checks they cross JSON. After a
   dispatch that succeeded, the daemon runs the checks `/reload` runs, so a
   command that changed machine config or trust needs no `/reload` after it.
2. **An allowlist, beside the route**
   (`src/interface/daemon/daemon-commands.client.ts`), as subsets of the
   modules' command groups:
   - enrollment's `ApplyEnrollmentCommand`, `UnenrollRepoCommand`,
     `PauseRepoCommand`, `ResumeRepoCommand`, `SetPersonaFlowCommand`,
     `SetFlowScheduleCommand` and `SetPersonaAccountCommand`;
   - trust's `TrustRepoCommand`.

   Any other tag is refused 404, whatever the bus could route. The route is
   served on the local socket only (`DAEMON_COMMAND_LISTENERS`), which only
   this machine's user reaches; which of these a TCP listener may dispatch is
   #330's to decide. `TrustRepoCommand` stays a person's: the socket is the
   CLI's, not an agent-facing adapter's.

3. **A remote dispatcher in the client** (`src/interface/daemon/daemon.client.ts`):
   `DaemonEnrollmentCommands` and `DaemonTrustCommands` offer the calls
   `EnrollmentCommands` and `TrustCommands` do, encoding the payload and
   decoding the answer with the same schemas. A command the daemon refused
   fails with the command's own error, so the CLI says what it would have said
   dispatching it itself. No daemon answering is `DaemonUnavailable`.
4. **Daemon first, then here.** `enroll` (its apply, once every question is
   asked), `unenroll`, `pause`, `resume`, `trust`, and the TUI's settings keys
   (a flow on and off, a schedule, an account, pause) dispatch through the
   daemon, and dispatch in their own process only on `DaemonUnavailable`
   (`throughDaemon`), as `cancel` does. A refusal from the daemon is the
   answer and is never retried here. Only the path in their own process asks
   the daemon to `/reload` after it, for one that started meanwhile.
5. **A command the daemon dispatches runs as the daemon**, so a command whose
   result depends on who ran it, or that records who did, carries that in its
   payload, as `CancelRequest.by` does. Of the allowlist, none does: their
   payloads name the repo (by name, slug or absolute path) and what to set;
   `ApplyEnrollmentCommand`'s path is the checkout's root, resolved in the CLI
   before it is sent, and its `offered` is what machine setup reads, the same
   for the daemon as for the person, who share the home. No trust record or
   enrollment event records who made it. A command added to the allowlist is
   checked for this first.
6. **What stays local:**
   - `setup` and `service`, which install, stop or uninstall the daemon
     itself;
   - `init`, `recipes` and scaffolding, which write in the checkout the person
     stands in (`init` enrolls through `enroll`'s apply, so that part goes
     through the daemon; its offer to re-point a moved checkout,
     `RepointRepoCommand`, asks part-way and stays here);
   - `rehearse` and `run --from-checkout`, which run their own engine on
     purpose (`rehearse` pauses and resumes the repo in its own process);
   - any command that asks the person something part-way through.

## Consequences

- What a person changes from the CLI or the TUI is said on the daemon's bus
  while the daemon runs, so an event adapter or the dashboard's stream hears
  it without polling; with no daemon, nobody was listening anyway.
- A daemon from before this route answers `/commands/:tag` with the router's
  bare 404. The route's own 404 always carries a `Refusal`. So the client
  treats a 404 with no refusal as `DaemonUnavailable`: that daemon can't
  dispatch the command and has refused nothing, so the command is dispatched
  here, and the old daemon picks it up as it did before this route. That
  covers the window between an upgrade and the old daemon's restart, which
  waits for its runs to finish. A refusal from a current daemon is still never
  retried here.
- `DAEMON_COMMAND_LISTENERS` names the socket alone, and nothing reads it yet,
  because the daemon has no other listener. The TCP listener #330 adds must
  check it before it serves this route.
  Since #330 it does: `DAEMON_COMMAND_LISTENERS.tcp` lets the dashboard's
  listener send `PauseRepoCommand`, `ResumeRepoCommand`,
  `SetPersonaFlowCommand`, `SetFlowScheduleCommand` and
  `SetPersonaAccountCommand`, and refuses the rest 404. A command whose file
  another process held too long is refused with `busy: true` on its `Refusal`.
- A command added to the allowlist needs no new route or protocol type, only
  its tag beside the others, and the check in decision 5.
