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
| `enter`        | Follow the selected run's log; `↑` `↓` scroll, `end` follows again, `esc` returns |
| `a`            | Attach to the run's agent session, to watch or step in                       |
| `t`            | Trigger the selected flow now, with its gates                                |
| `e`            | Turn the selected flow off or on for the persona it runs as, in machine config; pending until the daemon restarts on it, once idle |
| `p`            | Pause or resume the repo                                                     |
| `q`            | Quit                                                                         |

**Attach.** A session still running under a [launcher](/chernabog/agents/launchers/) comes up there — its Orca tab, or `tmux attach`. Otherwise it opens in the agent's own interactive UI (`claude --resume`, `codex resume`) in its worktree; exit the agent to come back. `chernabog attach <run>` does the same from the command line.

**Turn off or on.** `e` lists or unlists the flow under the persona's `flows` in machine config; a flow it turns off keeps its settings, as `enabled: false`. When the repo has several personas and this one inherits the repo entry's flows, it gets its own copy of them first, so the others keep theirs.

The view never runs work itself; it reads the daemon's state over its socket.
