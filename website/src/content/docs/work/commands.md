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
| `cancel <run>`, `cancel <repo> <item>` | End a run in flight for good, waiting or mid-step, through the daemon or, with it stopped, here. It's recorded as `cancelled`, its worktrees are removed (any with uncommitted or unpushed work is kept and named), and its claim is released: its claim ref (on its issue or pull request) is deleted, `auto:in-progress` and the assignment come off, and the claim branch is deleted unless it has commits or a pull request. A run that has already ended keeps its ending: cancelling it releases only the markers it still holds, by each marker's own release, and deletes a claim ref that still names it, which a flow baked before claims were refs leaves behind, and is refused when there is neither. It never comments, reviews, or closes or merges a pull request. `--flow` and `--as` pick among several runs on one item; `--close-session` also closes its agent sessions through their launcher, which are otherwise left to you |
| `logs <run> [-f]`                 | A run's log; `-f` follows it. `<run>` is its id, or enough of it to name one run, such as the 8 characters `status` shows |
| `attach <run>`                    | Open the run's agent session                                                     |
| `start <issue>`                   | Run the repo's entry flow, the one that declares `defineFlow({ start: true })` (the [`human-initiated` recipe](/chernabog/recipes/human-initiated/) does), on the issue, whatever its labels, through the daemon (which must be running), and bring its session up here: the Orca tab, or `tmux attach`. On an issue whose run is in flight, bring up that run's session |
| `open-pr --title <title>`         | From inside the session `chernabog start` opened: check the worktree is clean, and hand the work to chernabog, which runs the local gate, pushes, opens the pull request, waits for CI and asks a reviewer. The session stays open for you to close. With `--draft`, which the agent uses, it keeps the pull request as a draft and prints a question for the agent to ask you; your Yes hands it over |
| `pause <repo>`, `resume <repo>`   | Start no new runs in a repo; runs in flight continue                            |
| `trust [repo]`                    | Show what changed in `.chernabog/` since last trusted, and trust it             |
| `labels [repo]`                   | Create or correct the repo's labels                                              |
| `doctor`                          | Check logins, gh scopes, labels, trust, each repo's launcher, that each reviewer this machine acts as can merge, the [rulesets that protect progress records](/chernabog/operate/progress/#what-doctor-checks) and that each persona may write them, and the daemon; and print the warnings the repo's flows contribute (`defineFlow({ doctor })`), such as the recipes' reviewer-pool checks |
| `setup`                           | Choose the GitHub personas this machine acts as, and add AI accounts; safe to run again |
| `init [path]`                     | Scaffold `.chernabog/`, or refresh its schemas and pins, add `@chernabog/recipes` there, copy the [recipes](/chernabog/recipes/) chosen, write the [CI workflow](#ci-workflow) when `ci.flows` names a flow, then enroll the repo once it has a flow |
| `recipes list [path]`             | The recipes of each recipe package installed in `.chernabog/`, with their descriptions and docs pages: `✓` by the ones the repo copied, `→` by the ones it imports |
| `recipes add [names…]`            | Copy recipes into this repo's `.chernabog/`, recording the version each came from; asked in a terminal when none is named. Never overwrites a file the repo has. A name is `<package>/<recipe>`, or a bare name from `@chernabog/recipes` |
| `recipes add --import [names…]`   | Import recipes instead: write `flows.<name>.from` in `config.yaml` and move the package to `dependencies`, copying nothing |
| `recipes eject <flow>`            | Copy an imported flow, with its prompts and steps, into the repo, and remove its `from`; it runs on under the same name |
| `recipes diff [names…]`           | How this repo's copied flows, and the prompts their recipes render, differ from the versions of the recipes they came from |
| `recipes update [names…]`         | Move each recipe package to its newest version for the repo's SDK, and merge its changes into the copied recipes, keeping your edits and marking conflicts; in the working tree |
| `recipes upgrade`                 | Move this repo's `.chernabog/` to the SDK released with this binary, and its core and effect pins to the binary's, then its copied recipes to the newest versions for that SDK |
| `recipes compile [documents…]` | Compile this repo's [flow documents](/chernabog/flows/documents/) to flow files with the SDK it pins, all when none is named, and report each problem at its line in the document. `--check` writes nothing and fails if a flow file is out of date; `--json` gives the same result to read. Experimental |
| `enroll [path]`                   | Add a repo to this machine's config: which personas work in it, which flows each runs, which accounts they spend |
| `install`, `uninstall`            | Run `setup`, then register the daemon with launchd or systemd and start it; or remove it |
| `start`, `stop`                   | Start or stop the daemon; runs in flight resume when it starts again. `start` with an issue is the hybrid path, above |
| `daemon`                          | Run the daemon in the foreground (what the service runs)                         |
| `ci plan [--repo <repo>]`         | The plan job of a repo's GitHub Actions workflow; see [below](#ci-plan) |
| `ci run --flow <flow> --persona <login> --item <item>` | The run job: one item on one runner, to the next phase boundary; see [below](#ci-run) |
| `ci workflow [path] [--write]` | The workflow that runs them, printed or written to `.github/workflows/chernabog.yml`; see [below](#ci-workflow) |
| `ci apps [--repo <repo>] [--environments]` | Make the repo's GitHub Apps, author and reviewer, from manifests; see [below](#ci-apps) |
| `ui`                              | Open the [dashboard](/chernabog/operate/dashboard/) in the browser, starting it on 127.0.0.1 if it's off |
| `ui start`, `ui stop`             | Open the dashboard's 127.0.0.1 listener and print its URL, or close it; the daemon opens it again after a restart until it's stopped |
| `ui status`                       | Whether the dashboard is running, and its URL                                     |

## ci plan

`chernabog ci plan` is the plan job of a repo's workflow on GitHub Actions. It runs the triggers of the flows its `.chernabog/config.yaml` names under [`ci.flows`](/chernabog/reference/configuration/#repo), for the personas machine config chooses them for, and prints the run jobs to start as a JSON matrix, `[{"flow", "persona", "item"}]`. It applies a daemon tick's rules: a trigger's order, held items, items waiting on someone or left for others, the flow's gate (the usage gate among them) and its `concurrency`. It reads no `state.db`: an item already has a run when it has a live [claim](/chernabog/operate/daemon/#leases), and each flow's live claims count against its concurrency.

- **An event.** Given one (`GITHUB_EVENT_NAME` and `GITHUB_EVENT_PATH`, or `--event` and `--event-path`), it plans only for the flows the event [wakes](/chernabog/flows/documents/#the-github-events-that-wake-a-flow) and the item it concerns. An event a guard refuses, such as one the flow's own persona caused or a comment by someone the repo doesn't trust, wakes nothing: the plan prints `[]` before it runs any trigger.
- **The sweep.** With no event, or `schedule` or `workflow_dispatch`, it plans across every item, its triggers reading every thread's phase from one query. Items whose phase and GitHub disagree are held by their trigger, and listed.

It writes `items` (exactly `[]` when it starts nothing, which the run job's guard compares against) and `max-parallel` to `GITHUB_OUTPUT`, and why nothing else starts to `GITHUB_STEP_SUMMARY`, and prints the same reasons to stderr. `--repo` defaults to `GITHUB_REPOSITORY`; `--from-checkout` reads the working copy's `.chernabog/`.

## ci run

`chernabog ci run --flow <flow> --persona <login> --item <item>` is a run job of the workflow: one entry of the plan's matrix, on one runner. It runs the flow in the foreground, as `chernabog run` does, and ends the job at the next phase boundary.

- **A home of its own.** `CHERNABOG_HOME` must be a fresh directory, such as `$RUNNER_TEMP/chernabog`; it refuses a home that already holds runs. When the home has no machine config, it writes one enrolling the checkout (`GITHUB_WORKSPACE`) for the flow, as the job's `GH_TOKEN`, with `claude` under tmux on `CLAUDE_CODE_OAUTH_TOKEN`. On a runner with no `~/.claude.json`, it writes one with onboarding done and the checkout and worktrees trusted, so an interactive `claude` starts at its prompt.
- **Subscription billing only.** It stops with an error if `ANTHROPIC_API_KEY` is set, even empty, as a missing secret leaves it, which would bill per token. Agents run interactively, never with `-p`.
- **Another run got there first.** If the item's claim is held, or its trigger no longer reports the item to start (its phase moved since the plan), it says so and exits 0.
- **The phase boundary.** Where a run on a laptop would park on a signal, it lets go of the claim and exits 0; the event that settles the wait starts the next job, which reads the phase the run recorded. Unless the run ended, before the job exits it commits what the agent left uncommitted in its worktrees and pushes each branch that gains from it, never forced, so a job that stopped mid-phase repeats the phase from its start with the work on the branch. A branch GitHub no longer has (deleted, or merged and deleted) is never pushed again. A work-in-progress commit pushed to a pull request's branch is a `synchronize` like any other push, so it can start that pull request's review again.
- **Its claim is a short lease** (`--lease-seconds`, 15 minutes by default) that the job renews as it runs, so a killed job's claim runs out soon and the next job can take the item.
- **The time limit.** It stops on its own after `--stop-after-seconds` (5½ hours by default, inside a hosted job's 6), letting go of the claim and leaving the phase as it was, and exits 1.
- **Logs for diagnosis.** It copies the run log and the agent's transcripts to `--logs` (`$RUNNER_TEMP/chernabog-logs` on a runner), for the workflow to upload when the job fails. A failed CI run can't be resumed: the next job repeats the phase from its start.

It exits 1 when the run failed or ran out of time, and 0 otherwise. `--repo` defaults to `GITHUB_REPOSITORY`; `--from-checkout` reads the working copy's `.chernabog/`.

## ci workflow

`chernabog ci workflow --write` writes `.github/workflows/chernabog.yml`, the workflow that runs the flows `.chernabog/config.yaml` names under [`ci.flows`](/chernabog/reference/configuration/#repo); `chernabog init` writes it too. Without `--write` it prints it. Change the config or the flows and write it again rather than editing it: `chernabog doctor` checks the two still match.

- **What wakes it.** The events the CI flows [declare](/chernabog/flows/documents/#the-github-events-that-wake-a-flow), each with its `types:`; `repository_dispatch` `chernabog-phase` when a flow reads phases; `workflow_run: completed` filtered to the repo's CI workflows (those a push or a pull request starts, never this one); `ci.schedule` for the sweep; and `workflow_dispatch`, to sweep by hand. Never `pull_request_target`: it refuses to write a workflow that would wake on it.
- **A plan job, then a run job per item.** The plan job runs [`ci plan`](#ci-plan). The run job fans its matrix out with `strategy.matrix.include`, `fail-fast: false` and `max-parallel` from `ci.maxParallel`, and is skipped when the plan starts nothing. Each run job is in a `chernabog-<flow>-<item>` concurrency group that never cancels the job at work, so a later event for the same item waits for it.
- **Least access.** The workflow's own token only reads the checkout (`permissions: contents: read`), and the checkout is always the default branch, with that token left out of git's config. Chernabog acts as a persona: its token, the `CHERNABOG_TOKEN` secret, is the job's `GH_TOKEN`, since pushes and pull requests made with the workflow's own token start no other workflow. `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`, is the subscription's. Both are passed to the steps that run chernabog and to no other.
- **Logs.** Each run job uploads the run log and the agent's transcripts, whatever became of it, kept 5 days. On a public repo, anyone signed in to GitHub can download them.

Both jobs run the action published from this repo, `dataquail/chernabog/action`, at the tag of the chernabog that wrote the workflow, and it installs that release. On a runner, `ci plan` writes the home's machine config itself, enrolling the checkout for every CI flow as the job's `GH_TOKEN`, as `ci run` does for its one flow.

[Run on GitHub Actions](/chernabog/operate/github-actions/) walks through setting it up: the secrets, the rulesets, cost and security.

## ci apps

`chernabog ci apps` makes a repo's two [GitHub Apps](/chernabog/operate/github-actions/#github-apps), `<prefix>-author` and `<prefix>-review`, from manifests Chernabog writes. For each, it opens the browser on a page of its own on `127.0.0.1`, which sends you to GitHub's new-App page for the repo's owner, an organization's or yours, with the App's name and permissions filled in. You click **Create GitHub App**, then **Install** on the repo. Chernabog does the rest:

- it takes the App GitHub made, within the hour a code lasts, and keeps its private key at `~/.config/chernabog/keys/<slug>.pem`, readable only by you;
- it checks, as the App, that it's installed on the repo, rather than trusting what the redirect says;
- it adds the App to machine config as a persona, `github.<slug>[bot].token: { app: { id, installation, key } }`, so a daemon here can act as it;
- with `--environments`, it makes the repo's `chernabog-author` or `chernabog-review` Environment, with the App's id as the variable `CHERNABOG_APP_ID` and its key as the secret `CHERNABOG_APP_KEY`, and keeps `chernabog-review` to the default branch. That needs admin on the repo, as you.

`--repo` defaults to the checkout's. `--role author` or `--role reviewer` makes only one. `--prefix` names them (`<owner>-chernabog` by default, since an App's name is unique across GitHub). A role this machine already acts as reuses its App: an installation is the owner's, so the one App, and the one persona, serve every repo of that owner it's installed on. The command finds that App by asking GitHub, as each App this machine acts as, which owner it belongs to and whether it writes checks, as only the reviewer does. So it finds an App you renamed on GitHub's form, whatever case the owner's name is in. If it isn't on the repo yet, the command opens the App's install page, where you add the repo to its installation, and then makes the repo's Environment. `--replace` makes a new App instead. Each owner, organization or user, has Apps of its own, since a manifest makes an App only its owner can install. `--print` prints each page's URL instead of opening it. For each App it prints the App's id, its installation, and the persona this machine acts as it by.

## Through the daemon

A command that changes state asks the daemon to do it when the daemon is running, so what it changes is said on the daemon's bus, where the [dashboard](/chernabog/operate/dashboard/) and the live view hear it at once:

| Commands | With the daemon stopped |
| -------- | ----------------------- |
| `enroll` (once every question is asked, so `init`'s enrolling too), `unenroll`, `pause`, `resume`, `trust`, and the live view's settings (a flow on or off, a schedule, an account, pause) | They run here, in their own process, and the daemon picks up what they changed when it next starts |
| `run`, `cancel` | They run here: `run` in the foreground, following its run to the end; `cancel` releasing the run itself |
| `trigger`, `start <issue>`, `ui` | They need the daemon, and say so |

When the daemon is running and refuses a command, such as a repo that isn't enrolled, that refusal is the answer: the command isn't tried again here. A daemon from before this, still running until it restarts on an upgrade, can't take the first row's commands, so they run here as if it were stopped.

Some commands always run here: `setup`, `install`, `uninstall`, `start` and `stop`, which manage the daemon itself; `init` and `recipes`, which work in the checkout you stand in (`init` enrolls through the daemon, as `enroll` does); `rehearse` and `run --from-checkout`, which run their own engine on purpose; and any question asked part-way through a command, such as `init`'s offer to point a moved checkout's entry at its new place.

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
| `~/.config/chernabog/dashboard.json`   | Whether the [dashboard](/chernabog/operate/dashboard/) is to run, and its port, so a restarted daemon opens it again |
| `~/.config/chernabog/dashboard.token`  | The token in the dashboard's URL, readable only by you; `ui --rotate-token` replaces it |
