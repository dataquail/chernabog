---
title: Commands
description: Every chernabog command and flag.
---

`<repo>` is an enrolled repo, by name or `owner/name`. Where it is optional, the command covers every enrolled repo.

| Command                           | What it does                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `chernabog`                       | The [live view](/chernabog/work/live-view/)                                       |
| `status`                          | Repos, schedules and trust, runs in flight, recent runs, why ticks were skipped. A [manual flow](/chernabog/flows/flows/#manual-flows) shows as `manual`, with how to start it |
| `run <flow> --repo <repo>`        | One run now, skipping gates, through the daemon; follows its log                |
| `rehearse <flow> --repo <repo> --scenario <file>` | [Rehearse the flow](/chernabog/flows/rehearsing/) end to end on a seeded repo, with stand-ins where the agent would be; then clean up what it seeded |
| `trigger <flow> --repo <repo>`    | A tick now, with its gates, as if the schedule came due. A manual flow has no schedule, so this fails and says how to start it |
| `cancel <run>`, `cancel <repo> <item>` | End a run in flight for good, waiting or mid-step, through the daemon or, with it stopped, here. It's recorded as `cancelled`, its worktrees are removed (any with uncommitted or unpushed work is kept and named), and its claim is released: its claim ref (on its issue or pull request) is deleted, `auto:in-progress` and the assignment come off, and the claim branch is deleted unless it has commits or a pull request. A run that has already ended keeps its ending: cancelling it deletes only a claim ref that still names it, which a flow baked before claims were refs leaves behind, and is refused when there is none. It never comments, reviews, or closes or merges a pull request. `--flow` and `--as` pick among several runs on one item; `--close-session` also closes its agent sessions through their launcher, which are otherwise left to you |
| `logs <run> [-f]`                 | A run's log; `-f` follows it. `<run>` is its id, or enough of it to name one run, such as the 8 characters `status` shows |
| `attach <run>`                    | Open the run's agent session                                                     |
| `start <issue>`                   | Run the repo's entry flow, the one that declares `defineFlow({ start: true })` (the [`human-initiated` recipe](/chernabog/recipes/human-initiated/) does), on the issue, whatever its labels, through the daemon (which must be running), and bring its session up here: the Orca tab, or `tmux attach`. On an issue whose run is in flight, bring up that run's session |
| `open-pr --title <title>`         | From inside the session `chernabog start` opened: check the worktree is clean, and hand the work to chernabog, which runs the local gate, pushes, opens the pull request, waits for CI and asks a reviewer. The session stays open for you to close. With `--draft`, which the agent uses, it keeps the pull request as a draft and prints a question for the agent to ask you; your Yes hands it over |
| `pause <repo>`, `resume <repo>`   | Start no new runs in a repo; runs in flight continue                            |
| `trust [repo]`                    | Show what changed in `.chernabog/` since last trusted, and trust it             |
| `labels [repo]`                   | Create or correct the repo's labels                                              |
| `doctor`                          | Check logins, gh scopes, labels, trust, each repo's launcher, that each reviewer this machine acts as can merge, and the daemon; and print the warnings the repo's flows contribute (`defineFlow({ doctor })`), such as the recipes' reviewer-pool checks |
| `setup`                           | Choose the GitHub personas this machine acts as, and add AI accounts; safe to run again |
| `init [path]`                     | Scaffold `.chernabog/`, or refresh its schemas and pins, add `@chernabog/recipes` there, copy the [recipes](/chernabog/recipes/) chosen, then enroll the repo once it has a flow |
| `recipes list [path]`             | The recipes of each recipe package installed in `.chernabog/`, with their descriptions and docs pages: `✓` by the ones the repo copied, `→` by the ones it imports |
| `recipes add [names…]`            | Copy recipes into this repo's `.chernabog/`, recording the version each came from; asked in a terminal when none is named. Never overwrites a file the repo has. A name is `<package>/<recipe>`, or a bare name from `@chernabog/recipes` |
| `recipes add --import [names…]`   | Import recipes instead: write `flows.<name>.from` in `config.yaml` and move the package to `dependencies`, copying nothing |
| `recipes eject <flow>`            | Copy an imported flow, with its prompts and steps, into the repo, and remove its `from`; it runs on under the same name |
| `recipes diff [names…]`           | How this repo's copied flows, and the prompts their recipes render, differ from the versions of the recipes they came from |
| `recipes update [names…]`         | Move each recipe package to its newest version for the repo's SDK, and merge its changes into the copied recipes, keeping your edits and marking conflicts; in the working tree |
| `recipes upgrade`                 | Move this repo's `.chernabog/` to the SDK released with this binary, and its core and effect pins to the binary's, then its copied recipes to the newest versions for that SDK |
| `enroll [path]`                   | Add a repo to this machine's config: which personas work in it, which flows each runs, which accounts they spend |
| `install`, `uninstall`            | Run `setup`, then register the daemon with launchd or systemd and start it; or remove it |
| `start`, `stop`                   | Start or stop the daemon; runs in flight resume when it starts again. `start` with an issue is the hybrid path, above |
| `daemon`                          | Run the daemon in the foreground (what the service runs)                         |
| `ui`                              | Open the [dashboard](/chernabog/operate/daemon/#the-dashboard) in the browser, starting it on 127.0.0.1 if it's off |
| `ui start`, `ui stop`             | Open the dashboard's 127.0.0.1 listener and print its URL, or close it; the daemon opens it again after a restart until it's stopped |
| `ui status`                       | Whether the dashboard is running, and its URL                                     |

## Flags

| Flag                     | On       | Meaning                                                                 |
| ------------------------ | -------- | ----------------------------------------------------------------------- |
| `--item <key>`           | `run`    | Run on one work item, such as `issue-12`: one the trigger reports, or one the flow's `item` finds. A manual flow runs only with one |
| `--detach`               | `run`    | Start the run and return without following its log                      |
| `--from-checkout`        | `run`    | Run in this process with the working copy's `.chernabog/`; daemon stopped |
| `--from-checkout`        | `labels` | Read labels from the working copy, before `.chernabog/` is merged       |
| `--persona <a,b>`        | `setup`, `install` | The GitHub logins to act as, from `gh auth status`. Asked in a terminal when `gh` has several |
| `--account <dir[:agent],…>` | `setup`, `install` | Account directories to add, such as `~/.claude-personal`. Found ones are asked about in a terminal |
| `--recipes <a,b>`        | `init`   | The recipes to copy. Asked in a terminal; piped and without it, none   |
| `--import`               | `recipes add` | Import the recipes, to run from their package, rather than copy them |
| `--package <dir>`        | `rehearse` | A recipe package's checkout to load imported flows from, in place of the version installed |
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
| `--draft`                | `open-pr` | Keep it as a draft and print the question that asks you whether to open it |
| `-f`, `--follow`         | `logs`   | Keep printing as the log grows                                          |
| `--port <n>`             | `ui`, `ui start` | The port on 127.0.0.1 to open the dashboard on; the last one asked for when left out, else `4848`. A port in use is refused |
| `--print`                | `ui`     | Print the dashboard's URL instead of opening it in the browser          |
| `--rotate-token`         | `ui`     | Make a new token first; the URL a browser or bookmark holds stops working |

## Files

| Path                                   | Holds                                              |
| -------------------------------------- | -------------------------------------------------- |
| `~/.config/chernabog/config.yaml`      | [Machine config](/chernabog/reference/configuration/#machine) |
| `~/.config/chernabog/state.db`         | The workflow engine's journal                      |
| `~/.config/chernabog/daemon.log`       | The daemon's log, today's (UTC); earlier days' are `daemon.<YYYY-MM-DD>.log`, kept 30 days |
| `~/.config/chernabog/daemon.out.log`   | The daemon's stdout and stderr, as the service manager catches them |
| `~/.config/chernabog/runs/<run>.log`   | Each run's log, kept 30 days after the run finishes |
| `~/.config/chernabog/telemetry/<day>/` | Spans and logs of the daemon and each CLI command, a file a process; kept 30 days and to 500 MB |
| `~/.config/chernabog/dashboard.json`   | Whether the [dashboard](/chernabog/operate/daemon/#the-dashboard) is to run, and its port, so a restarted daemon opens it again |
| `~/.config/chernabog/dashboard.token`  | The token in the dashboard's URL, readable only by you; `ui --rotate-token` replaces it |
