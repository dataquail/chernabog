---
title: The daemon
description: Scheduling, limits, the workflow engine and where it logs.
---

One daemon per machine schedules every enrolled repo, runs the workflow engine, and serves the CLI over a local socket. `chernabog install` registers it as a launchd agent (macOS) or systemd user service (Linux) that restarts on exit.

## Ticks

Each flow's trigger runs on a cron schedule: `flows.<flow>.schedule`, else the flow module's own `schedule`, else the repo's (`local.yaml` over `config.yaml`), else hourly at a minute that spreads repos across the hour. Before a tick starts a run, the daemon checks, in order:

| Check              | Set by                       | Skip reason                         |
| ------------------ | ---------------------------- | ----------------------------------- |
| repo enabled       | `local.yaml` `enabled`       | `disabled in local.yaml`            |
| flow enabled       | `flows.<flow>.enabled`       | `flow turned off`                   |
| pause              | `chernabog pause <repo>`     | `paused`                            |
| quiet hours        | machine `quietHours`         | `quiet hours (22:00-07:00)`         |
| active hours       | `local.yaml` `activeHours`   | `outside active hours (…)`          |
| concurrency        | machine, repo and flow `concurrency` | no free slot                |
| the flow's gate    | `defineFlow({ gate })`       | e.g. `usage gate: …`                |

Hours are `HH:MM-HH:MM` in local time, and may wrap midnight. Every skipped tick is recorded with its reason; `status` shows the latest. A repo can lower `concurrency`, never raise it past the machine's.

A run waiting on a signal — a review waiting for its author's push — holds no slot.

## The engine

The journal is `~/.config/chernabog/state.db`. A lock file next to it keeps a second engine from starting, which is why `run --from-checkout` needs the daemon stopped. Each step a team writes runs in a child process, so a step that crashes or hangs fails only its own activity. Runs in flight when the daemon stops resume when it starts.

## Logs

| File                                 | Holds            |
| ------------------------------------ | ---------------- |
| `~/.config/chernabog/daemon.log`     | the daemon       |
| `~/.config/chernabog/runs/<run>.log` | one run; `chernabog logs <run> -f` |
