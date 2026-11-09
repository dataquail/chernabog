# 18. Token usage is the adapter's to read and the daemon's to record

Status: accepted, 2026-11-09. Epic #405 (#406, #407, #408, #409, #410, #411,
#412). Builds on the runs module's queries of [ADR 11](0011-queries-read-their-storage.md).

## Context

Chernabog spends subscription capacity on every agent call, and until #405 it
said nothing about how much: not per run, not per step, not per model. A
person deciding whether a recipe is worth running, or why one run cost more
than another, had only the vendor's own screens, which know nothing of runs.
How long a run computed for was no better: a run's wall time counts the days
it sat parked on a review or slept between CI polls.

Each vendor writes what a session spent somewhere of its own: Claude in its
transcripts, Codex in its rollout files, OpenCode in its JSON events. A
session is not a run either. `address-review` resumes the author's session
from another run, and `hybrid` keys its session by issue, so one session's
records span several runs and several calls.

`Usage` already names something else: the quota gate, the core port and
`src/modules/runs/domain/usage/` (`decideLaunch`).

## Decisions

1. **Raw tokens and the model, never dollars.** An adapter that can report
   gives four counts per model per call: input, output, cache read and cache
   write (`ModelUsage`, `src/modules/runs/domain/token-usage/`). A count the
   vendor doesn't report is none, not zero. Pricing and cost estimates are out
   of scope: prices change, subscriptions don't bill per token, and a wrong
   dollar figure is worse than none.
2. **The adapter reads, the daemon records, nothing else sees it.** An agent
   adapter (`src/modules/runs/infrastructure/runtime/agents/`) may implement
   an optional `usage(session, cursor)` that reads its own vendor's records.
   `AgentLive.run` (`runtime/agents.ts`) wraps every call in
   `recordingTokenUsage` (`agents/token-usage.ts`), which reads and records
   in a finalizer, so a call that fails or is interrupted still records what
   it spent. The engine provides the `TokenUsageRecorder` that writes through
   `RecordTokenUsageCommand`; without it, as in a step's own process, nothing
   is recorded. Flows, `@chernabog/core` and `@chernabog/sdk` don't change: a
   flow calls `Agent.run` and never learns of usage. Reading or recording
   never fails the call.
3. **Records belong to runs.** `om_agent_usage` keeps one row per agent call
   and model: run, step, adapter, session, model, the four counts, and
   `reported`. A run's totals and its breakdowns by step and by model are
   aggregated when `ReadRunUsageQuery` reads them, never stored.
4. **Each call is charged by a cursor per session.** Since sessions cross
   runs, a call charges only what it added. Each adapter takes and returns a
   cursor whose form only it understands (Claude: an offset per transcript
   and the last message id; Codex: the last running total; OpenCode: the last
   step counted), kept in `om_usage_cursors` by adapter and session. The rows
   and the moved cursor commit in one unit of work, so a crash between the
   call and the write leaves the cursor where it was, and the next call on
   that session picks up what was missed.
5. **Not reported is not zero.** A call through an adapter with no `usage`
   (custom, rehearsal), or whose reader fails, writes one row with
   `reported = false` and leaves the cursor alone. The run's totals are then
   floors, and the dashboard says "at least N".
6. **Total tokens sums all four categories**, with the breakdown beside it.
   Cache reads dominate that number; the breakdown is there to say so.
7. **Compute time is the union of a run's steps**
   (`domain-services/compute-time.domain-service.ts`): the time covered by at
   least one step in `om_steps`, with overlapping steps (a `forEach`'s lanes)
   counted once. Parked waits and durable sleeps fall between steps, so they
   count for nothing. A step with no finish (interrupted) ends at its next
   entry, else at the run's finish, else now. A run with no steps recorded
   has no compute time, not zero. A hybrid session open for days counts in
   full: it was a step all that time.
8. **`TokenUsage`, not `Usage`.** The new concept lives in its own domain
   folders (`token-usage/`, `token-usage-cursor/`) and never shares a name
   with the quota gate.

## Rejected

- **A post-run step in the flow** that reads what the run spent. Flows don't
  know vendors, so each would need to; a run that failed or was cancelled
  never reaches its last step, which is exactly the run a person most wants
  to account for; and every recipe would have to opt in, one by one.
- **`AgentResult.costUsd`.** It is dollars, which decision 1 rules out; only
  some vendors fill it; and a failed call returns an `AgentError` and no
  result, so it would miss what failures spent. It stays in core as it is:
  removing it would take a major.
- **Wall time minus `om_waits`** for compute time. Its rows are deleted when
  a wait is released, so a finished run has none left to subtract; waits
  overlap, so subtracting them double-counts; and durable sleeps write no
  wait at all.

## Consequences

- A new adapter reports usage by implementing `usage` alone; nothing in the
  engine, the query or the dashboard changes. One that doesn't is still
  recorded, as not reported.
- Totals move only when a call ends. There is no live count during a running
  call.
- A session's first call charged through Chernabog charges everything the
  session spent before it, since it has no cursor yet. For a session
  Chernabog started, that is the same thing.
- Out of scope, and left so: dollars, budgets, alerts, stopping a flow on
  usage, and a usage reader for custom agents.
