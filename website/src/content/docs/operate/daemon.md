---
title: The daemon
description: Scheduling, limits, the workflow engine and where it logs.
---

One daemon per machine schedules every enrolled repo, runs the workflow engine, and serves the CLI over a local socket. `chernabog install` runs [`chernabog setup`](/chernabog/start/installation/#set-up-the-machine), then registers it as a launchd agent (macOS) or systemd user service (Linux) that restarts on exit.

## Ticks

Each flow's trigger runs on a cron schedule. When it runs is the person's call, so the repo's entry in machine config comes first (its persona's, where it has one): its `flows.<flow>.schedule`, then its `schedule`. Then the team's: `config.yaml`'s `flows.<flow>.schedule`, the flow module's own `schedule`, and `config.yaml`'s `schedule`. Without any of them it runs hourly, at a minute that spreads repos across the hour. Before a tick starts a run, the daemon checks, in order:

| Check              | Set by                       | Skip reason                         |
| ------------------ | ---------------------------- | ----------------------------------- |
| repo enabled       | repo entry's `enabled`       | `disabled in machine config`        |
| flow listed        | repo entry's `flows`         | `flow turned off`                   |
| pause              | `chernabog pause <repo>`     | `paused`                            |
| quiet hours        | machine `quietHours`         | `quiet hours (22:00-07:00)`         |
| active hours       | repo entry's `activeHours`   | `outside active hours (…)`          |
| assignee, reviewer | `flows.<flow>.assignee`, `reviewRequested` | `only work for others: …` |
| concurrency        | machine, repo and flow `concurrency` | no free slot                |
| the flow's gate    | `defineFlow({ gate })`       | e.g. `usage gate: …`                |

Hours are `HH:MM-HH:MM` in local time, and may wrap midnight. Every skipped tick is recorded with its reason; `status` shows the latest. A repo can lower `concurrency`, never raise it past the machine's.

A run waiting on a signal holds no slot.

### Ticks on events

Cron is the backstop; two kinds of event tick a flow sooner. Each runs the same tick as cron and `t` do, every check above included, so an event never starts what a scheduled tick wouldn't. An event decides nothing itself: the trigger reads the real state.

- **A change a run here makes.** When a run on this machine opens or pushes to a pull request, requests or submits a review, merges, labels, comments, or ends, every flow of that repo is due, for each persona whose `events.local` is on (the default). This is how one persona's pull request reaches another's `review` on the same machine within seconds. A run that ends without finishing its work (failed, skipped, handed to a person) leaves its own flow to cron, so an item that fails fast is retried no more often than before.
- **A persona's GitHub notifications.** With `events.notifications` on, the daemon polls each persona's `GET /notifications` at the interval GitHub asks for (about a minute), with `If-Modified-Since`, so an answer that nothing changed is a 304 that costs no rate limit. A notification about an enrolled repo makes that persona's flows there due. This covers handoffs between machines: a review requested of you, a review on your pull request. The daemon never marks a notification read. A token that can't read notifications (fine-grained tokens can't) shows in `status` with the fix, and that persona's flows go on ticking on cron.

Several events within a few seconds make one tick, and the repo's `limits.eventTickMin` (default `30 seconds`) caps how often events tick one persona's flow. `status` shows what made each flow's last tick (`cron`, `manual`, `local: #73 review requested`, `notification: review_requested on #73`), and `next due now` while an event's tick waits to run.

The daemon reads machine config's enrolled repos when it starts, and checks them every ten seconds. When they change — a repo `chernabog enroll` adds, one dropped or moved, a flow turned on or off for a persona — the daemon restarts on them once nothing is executing, as it does on newly trusted config. Runs in flight resume, and `status` says a restart is pending. A new repo shows in `status` as `untrusted` until you run `chernabog trust` on it.

A repo whose checkout is gone shows as `missing`, with `checkout missing at <path>`, and starts no runs. Its settings stay in machine config. When the checkout comes back, or `chernabog init` at its new place points the entry there, the daemon restarts on it.

## The engine

The journal is `~/.config/chernabog/state.db`. A lock file next to it keeps a second engine from starting, which is why `run --from-checkout` needs the daemon stopped. Each step a team writes runs in a child process, so a step that crashes or hangs fails only its own activity. Runs in flight when the daemon stops resume when it starts.

## Logs

| File                                 | Holds            |
| ------------------------------------ | ---------------- |
| `~/.config/chernabog/daemon.log`     | the daemon       |
| `~/.config/chernabog/runs/<run>.log` | one run; `chernabog logs <run> -f` |
