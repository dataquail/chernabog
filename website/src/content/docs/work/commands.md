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
| `pause <repo>`, `resume <repo>`   | Start no new runs in a repo; runs in flight continue                            |
| `trust [repo]`                    | Show what changed in `.chernabog/` since last trusted, and trust it             |
| `labels [repo]`                   | Create or correct the repo's labels                                              |
| `doctor`                          | Check logins, gh scopes, labels, trust, each repo's launcher and the daemon      |
| `init [path]`                     | Scaffold `.chernabog/`, or refresh its schemas and pins                         |
| `enroll [path]`                   | Add a repo to this machine's config, and choose which of its flows run here      |
| `install`, `uninstall`            | Register the daemon with launchd or systemd and start it; or remove it          |
| `start`, `stop`                   | Start or stop the daemon; runs in flight resume when it starts again            |
| `daemon`                          | Run the daemon in the foreground (what the service runs)                         |

## Flags

| Flag                     | On       | Meaning                                                                 |
| ------------------------ | -------- | ----------------------------------------------------------------------- |
| `--item <key>`           | `run`    | Run on one work item the trigger reports, such as `issue-12`            |
| `--detach`               | `run`    | Start the run and return without following its log                      |
| `--from-checkout`        | `run`    | Run in this process with the working copy's `.chernabog/`; daemon stopped |
| `--from-checkout`        | `labels` | Read labels from the working copy, before `.chernabog/` is merged       |
| `--account <name>`       | `enroll` | The machine-config account whose budget this repo spends                |
| `--name <name>`          | `enroll` | A short name, when two enrolled repos share one                         |
| `--flows <a,b>`          | `enroll` | The flows to run here; the rest are turned off. Asked in a terminal when left out |
| `-f`, `--follow`         | `logs`   | Keep printing as the log grows                                          |

## Files

| Path                                   | Holds                                              |
| -------------------------------------- | -------------------------------------------------- |
| `~/.config/chernabog/config.yaml`      | [Machine config](/chernabog/reference/configuration/#machine) |
| `~/.config/chernabog/state.db`         | The workflow engine's journal                      |
| `~/.config/chernabog/daemon.log`       | The daemon's log                                   |
| `~/.config/chernabog/runs/<run>.log`   | Each run's log                                     |
