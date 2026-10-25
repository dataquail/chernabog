---
title: The live view
description: chernabog with no arguments — a live view of the daemon, its flows and its runs.
---

`chernabog` with no arguments opens a live view of the daemon:

- each repo and its flows, with their next tick and what the last tick found queued;
- account usage against the [usage gate](/chernabog/agents/usage-gate/)'s thresholds;
- runs in flight with their current step, and recent runs;
- why recent ticks were skipped.

| Key            | Does                                                                         |
| -------------- | ---------------------------------------------------------------------------- |
| `tab`, `↑` `↓` | Switch between flows and runs, and select                                    |
| `enter`        | On a run: follow its log; `↑` `↓` scroll, `end` follows again, `esc` returns. On a flow: its persona's [settings](#settings) |
| `a`            | Attach to the run's agent session, to watch or step in                       |
| `x`            | Cancel the selected run in flight, once you confirm with `y`; see [`cancel`](/chernabog/work/commands/) |
| `t`            | Trigger the selected flow now, with its gates                                |
| `e`            | Turn the selected flow off or on for the persona it runs as, in machine config; pending until the daemon restarts on it, once idle |
| `p`            | Pause or resume the repo                                                     |
| `q`            | Quit                                                                         |

**Attach.** A session still running under a [launcher](/chernabog/agents/launchers/) comes up there — its Orca tab, or `tmux attach`. Otherwise it opens in the agent's own interactive UI (`claude --resume`, `codex resume`) in its worktree; exit the agent to come back. `chernabog attach <run>` does the same from the command line.

**Turn off or on.** `e` lists or unlists the flow under the persona's `flows` in machine config; a flow it turns off keeps its settings, as `enabled: false`. When the repo has several personas and this one inherits the repo entry's flows, it gets its own copy of them first, so the others keep theirs.

## Settings

`enter` on a flow opens the settings of the persona it runs as, for that repo: each of the persona's flows, on or off, with its schedule next to the team's and when it runs next; then the account its runs spend and each role's (a role from the team's `flows.<flow>.agents`, or one the persona picked an account for).

| Key            | Does                                                                         |
| -------------- | ---------------------------------------------------------------------------- |
| `e`            | Turn the selected flow on or off                                             |
| `s`            | Type a schedule for the selected flow, as cron; `enter` saves it, `esc` cancels. An invalid one is refused with the reason, and nothing is written |
| `enter`        | On the account or a role: choose one of machine config's accounts            |
| `c`            | Clear the selected override: a flow's schedule goes back to the team's, an account to the default |
| `esc`          | Back to the main view                                                        |

Each change is written to the repo's entry in [machine config](/chernabog/reference/configuration/), under the persona's own entry where it has one, keeping the file's comments: a schedule as `flows.<flow>.schedule` (a flow the persona doesn't run keeps it, off), an account as `account`, a role's as `roles.<role>`. The daemon picks changes up when idle, as it does for any edit to machine config. An account that would fail the repo, such as one on the same agent as the persona's own for a role, is refused, and nothing is written.

The view never runs work itself; it reads the daemon's state over its socket.
