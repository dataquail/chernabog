---
title: Commands
description: Every chernabog command and flag.
---

`<repo>` is an enrolled repo, by name or `owner/name`. Where it is optional, the command covers every enrolled repo.

| Command                           | What it does                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `chernabog`                       | The [live view](/chernabog/work/live-view/)                                       |
| `status`                          | Repos, schedules and trust, runs in flight, recent runs, why ticks were skipped |
| `run <flow> --repo <repo>`        | One run now, skipping gates, through the daemon; follows its log                |
| `trigger <flow> --repo <repo>`    | A tick now, with its gates, as if the schedule came due                         |
| `logs <run> [-f]`                 | A run's log; `-f` follows it. `<run>` is its id, or enough of it to name one run, such as the 8 characters `status` shows |
| `attach <run>`                    | Open the run's agent session                                                     |
| `start <issue>`                   | Run the [`start` flow](/chernabog/work/flows/#start) on the issue, whatever its labels, through the daemon (which must be running), and bring its session up here: the Orca tab, or `tmux attach`. On an issue whose run is in flight, bring up that run's session |
| `open-pr --title <title>`         | From inside the session `start` opened: check the worktree is clean, and hand the work to chernabog, which runs the local gate, pushes, opens the pull request, waits for CI and asks a reviewer. The session stays open for you to close |
| `pause <repo>`, `resume <repo>`   | Start no new runs in a repo; runs in flight continue                            |
| `trust [repo]`                    | Show what changed in `.chernabog/` since last trusted, and trust it             |
| `labels [repo]`                   | Create or correct the repo's labels                                              |
| `doctor`                          | Check logins, gh scopes, labels, trust, each repo's launcher, that each reviewer this machine acts as can merge, and the daemon |
| `setup`                           | Choose the GitHub personas this machine acts as, and add AI accounts; safe to run again |
| `init [path]`                     | Scaffold `.chernabog/`, or refresh its schemas and pins, then enroll the repo   |
| `enroll [path]`                   | Add a repo to this machine's config: which personas work in it, which flows each runs, which accounts they spend |
| `install`, `uninstall`            | Run `setup`, then register the daemon with launchd or systemd and start it; or remove it |
| `start`, `stop`                   | Start or stop the daemon; runs in flight resume when it starts again. `start` with an issue is the hybrid path, above |
| `daemon`                          | Run the daemon in the foreground (what the service runs)                         |

## Flags

| Flag                     | On       | Meaning                                                                 |
| ------------------------ | -------- | ----------------------------------------------------------------------- |
| `--item <key>`           | `run`    | Run on one work item, such as `issue-12`: one the trigger reports, or one the flow's `item` finds |
| `--detach`               | `run`    | Start the run and return without following its log                      |
| `--from-checkout`        | `run`    | Run in this process with the working copy's `.chernabog/`; daemon stopped |
| `--from-checkout`        | `labels` | Read labels from the working copy, before `.chernabog/` is merged       |
| `--persona <a,b>`        | `setup`, `install` | The GitHub logins to act as, from `gh auth status`. Asked in a terminal when `gh` has several |
| `--account <dir[:agent],…>` | `setup`, `install` | Account directories to add, such as `~/.claude-personal`. Found ones are asked about in a terminal |
| `--persona <a,b>`        | `init`, `enroll` | The personas that work in this repo. Asked in a terminal when machine config has several |
| `--flows <a,b>`          | `init`, `enroll` | The flows to run, for every chosen persona; the rest are off. Asked in a terminal for each persona |
| `--defaults`             | `init`, `enroll` | The team's default flows, for every chosen persona, without asking |
| `--account <a,b>`        | `init`, `enroll` | Accounts from machine config: the persona's own, and one for each other agent its flows need. Asked in a terminal where there's a choice |
| `--name <name>`          | `init`, `enroll` | A short name, when two enrolled repos share one                         |
| `--repo <repo>`          | `start`  | The enrolled repo the issue is in; the one this directory is in when left out, else the only one |
| `--as <login>`           | `start`  | The persona that authors the work, for a repo that runs as several      |
| `--body <markdown>`      | `open-pr` | The pull request body, without the `Closes` line, which chernabog adds  |
| `--body-file <file>`     | `open-pr` | A file holding the body, instead of `--body`                           |
| `--summary <text>`       | `open-pr` | What changed and how it was tested, for the issue; the title when left out |
| `-f`, `--follow`         | `logs`   | Keep printing as the log grows                                          |

## Files

| Path                                   | Holds                                              |
| -------------------------------------- | -------------------------------------------------- |
| `~/.config/chernabog/config.yaml`      | [Machine config](/chernabog/reference/configuration/#machine) |
| `~/.config/chernabog/state.db`         | The workflow engine's journal                      |
| `~/.config/chernabog/daemon.log`       | The daemon's log                                   |
| `~/.config/chernabog/runs/<run>.log`   | Each run's log                                     |
