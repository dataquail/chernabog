---
title: Launchers
description: Where an interactive Claude session runs, who chooses, and how to define your own.
---

A launcher decides where an interactive Claude session runs. Nothing runs `claude -p` unless the launcher is `headless`.

| Launcher   | A session is                                         | Attach                     |
| ---------- | ---------------------------------------------------- | -------------------------- |
| `orca`     | a terminal tab in Orca on the worktree               | `orca terminal switch`     |
| `tmux`     | a detached tmux session, `chernabog-<session>`       | `tmux attach-session`      |
| `headless` | `claude -p`, a child process of the run              | `claude --resume`          |
| your own   | `launchers.<name>` in machine config                 | its `attach`, if it has one |

Only Claude has an interactive mode. Every other agent runs headless under any launcher.

## Finishing a session

Under a launcher the prompt asks the agent to write its final answer as JSON to a file and stop. A Stop hook checks that file against the answer's schema and sends the agent back until it is valid — three times at most, then the run fails. When the session is done, Chernabog closes it.

- A session that ends without an answer is resumed twice before the run fails.
- A session still running when the daemon restarts is waited on again, never started twice.
- The run log follows the session's transcript.
- An expired login token is refreshed the same way: a one-line session under the repo's launcher, closed once the token is fresh.

## Who chooses

The launcher describes a person's own machine, so their choice beats the team's default.

| Precedence | Layer                    | Key                |
| ---------- | ------------------------ | ------------------ |
| 1          | `.chernabog/local.yaml`  | `launcher`         |
| 2          | machine config           | `launcher`         |
| 3          | `.chernabog/config.yaml` | `launcher`         |
| 4          | —                        | `headless`         |

A team limits the choice with `allowedLaunchers`. A launcher outside that list fails the repo, naming the layer that chose it; Chernabog never falls back to another.

```yaml
# .chernabog/config.yaml
launcher: orca
allowedLaunchers: [orca, tmux, headless]
```

## Your own launcher

Only machine config can define one: a repo can name and limit launchers, but not define commands that run in your terminal.

| Key      | Required | Does                                                         |
| -------- | -------- | ------------------------------------------------------------ |
| `start`  | yes      | starts the session; prints its handle, or nothing to use `{title}` |
| `close`  | yes      | ends it                                                      |
| `alive`  | no       | exits 0 while the session runs; without it, running until done |
| `attach` | no       | brings it up for a person                                    |

Templates fill in `{command}` (the whole command, quoted for a shell), `{cwd}`, `{title}` and `{handle}`.

```yaml
# ~/.config/chernabog/config.yaml
launcher: wezterm
launchers:
  wezterm:
    start: [wezterm, cli, spawn, --cwd, "{cwd}", --, sh, -c, "{command}"]
    close: [wezterm, cli, kill-pane, --pane-id, "{handle}"]
```

Every launcher runs the same short command, `chernabog __launch <spec>`, which starts Claude with its account's environment and the prompt from a file.

:::note[Folder trust]
An interactive session stops at "Do you trust this folder?" in a folder Claude doesn't trust yet. Worktrees inherit the trust of their checkout, so trust the checkout once, or a folder above it. `doctor` checks this, and that the launcher's tool works.
:::
