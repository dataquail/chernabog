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
| `p`            | Pause or resume the repo                                                     |
| `q`            | Quit                                                                         |

**Attach.** A session still running under a [launcher](/chernabog/agents/launchers/) comes up there — its Orca tab, or `tmux attach`. Otherwise it opens in the agent's own interactive UI (`claude --resume`, `codex resume`) in its worktree; exit the agent to come back. `chernabog attach <run>` does the same from the command line.

The view never runs work itself; it reads the daemon's state over its socket.
