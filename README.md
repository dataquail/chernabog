# Chernabog

Chernabog spends spare coding-agent capacity on queued work across your repos. Teams commit flows to each repo, the way husky commits git hooks. Flows are durable Effect workflows built from an SDK of services for the job: GitHub, coding agents, git worktrees and usage budgets. People stay at the edges: they queue the work, set budgets and hours, handle escalations and merge.

Documentation: <https://dataquail.github.io/chernabog/>.

Chernabog is early: it runs on macOS and Linux (Windows through WSL2), with Claude Code, Codex or opencode as the agent, and GitHub as the forge.

## Install

With Homebrew, on macOS or Linux:

```bash
brew install dataquail/tap/chernabog
```

After `brew upgrade chernabog`, the daemon notices its binary changed, starts no new runs, and restarts on the new version once the runs executing now finish (see [Chernabog versions](#chernabog-versions)).

Without Homebrew, each release attaches a binary for macOS and Linux, on arm64 and x64, with a `sha256` file. With `gh`:

```bash
target=darwin-arm64                  # or darwin-x64, linux-x64, linux-arm64
tag=$(gh api repos/dataquail/chernabog/releases --jq '[.[].tag_name | select(startswith("v"))][0]')
gh release download "$tag" --repo dataquail/chernabog --pattern "chernabog-$tag-$target.tar.gz" --pattern "chernabog-$tag-sha256.txt"
grep -- "-$target.tar.gz" "chernabog-$tag-sha256.txt" | shasum -a 256 -c -
tar -xzf "chernabog-$tag-$target.tar.gz"
mv chernabog ~/.local/bin/           # or anywhere on your PATH
```

The binary's tags start with `v`; core's, the SDK's and the recipes' start with `core-v`, `sdk-v` and `recipes-v`, so GitHub's "latest release" is sometimes one of theirs, and the first line picks the newest `v` tag instead. Download with `gh` or `curl` rather than a browser: the macOS binaries are signed ad hoc, not notarized, and Gatekeeper blocks a browser download.

To upgrade, install the new binary the same way; the daemon drains and restarts on it, as it does after `brew upgrade`. `mv` replaces the file rather than writing over it, which macOS requires of a signed binary that is running.

Or build it from source:

```bash
git clone https://github.com/dataquail/chernabog && cd chernabog
bun install
bun run build                        # dist/chernabog
mv dist/chernabog ~/.local/bin/
```

It needs `git` and `gh` (logged in, with the `repo` scope) and the agent's own CLI. `tmux` or Orca are optional, as [launchers](#launchers).

## Build

```bash
bun install
bun test
bun run build        # dist/chernabog, one self-contained binary
bun run lint         # oxlint, type-aware, warnings fail it
```

The docs site is a separate Astro package in `website/`: `cd website && bun install && bun --bun run dev`. Its pages live in `website/src/content/docs/`.

The lint baseline is [functional-domain-driven-hexagon](https://github.com/dataquail/functional-domain-driven-hexagon)'s: `@effect/tsgo` and `oxlint-plugin-effect` recommended, plus the anti-slop and effect-oxc plugins vendored under `tools/oxlint/`. Code reads as Effect all the way down: `Option` instead of null and undefined, Schema at every JSON and file boundary, the platform's FileSystem, ChildProcess, HttpClient and Clock instead of Node's and the globals. Two places hand that contract to the host, and `.oxlintrc.json` says why for each: `src/platform/`, the one reader of the process environment, and `test/acceptance/`, which drives the built CLI as a black box on bun:test's promises. Unit tests are Effects too, run by `effect-bun-test`. The linter's TypeScript plugins need Node 22.6 or newer on the PATH.

## Set up a repo

```bash
chernabog install                   # chooses GitHub personas and AI accounts, then registers the daemon and starts it
cd ~/code/my-app
chernabog init                      # scaffolds .chernabog/, copies the recipes you pick into its flows, then enrolls the repo
git add .chernabog .gitignore && git commit -m "chore: set up chernabog" && git push
chernabog trust my-app              # approves the base branch's .chernabog/
chernabog labels my-app             # creates the auto:* labels
chernabog doctor                    # checks logins, gh scopes, labels, trust and the daemon
```

`install` runs `chernabog setup` first, which you can run again on its own. It asks only what it has to. **GitHub personas:** the logins in `gh auth status`; with one it's chosen without asking, with several you pick which ones Chernabog acts as. **AI accounts:** it finds `~/.claude*` and `~/.codex*` directories not yet in machine config, asks which to add, then asks for others, such as `~/.claude-personal` behind a `pclaude` alias. It stores each account's config directory and agent, never the alias, and names it after the directory (`claude-personal`). `--persona a,b` and `--account ~/.claude-personal,~/.codex-work:codex` answer without asking.

`init` installs [`@chernabog/recipes`](https://dataquail.github.io/chernabog/recipes/) in `.chernabog/`, lists its recipes, complete flows to copy into `.chernabog/flows/`, and copies the ones you pick; none is copied unless chosen, and `--recipes a,b` chooses without asking. It then enrolls the repo, once it has a flow, asking: which personas work in it (when there are several), which flows each one runs (a checklist prefilled with the team's defaults, with "Accept the defaults" first, so enter takes them), and which account each persona spends where machine config has a choice. A flow whose agent has no account is listed but can't be picked, and says to add one with `chernabog setup`. `chernabog enroll` runs the same questions on its own, to enroll a repo that already has `.chernabog/` or to choose again. `--persona`, `--flows a,b`, `--defaults` and `--account` answer without asking; piped and without them, a repo keeps the flows it lists, and a new one gets the team's defaults.

Queue work by labelling an issue `auto:eligible`. On each repo's schedule (hourly by default, repos spread across the hour) the daemon runs the `implement` flow's trigger; if the machine has a free slot and the account's usage gate passes, it claims the oldest queued issue, lets the agent implement it in a worktree, runs the local gate, opens the pull request, waits for CI and asks one reviewer from the team's pool to review it. Label it `auto:ship` instead for the automated path, where the approving reviewer merges. For work that needs a person through planning and implementation, `chernabog start <issue>` is the hybrid path, the `human-initiated` recipe; see below.

## Recipes and the review loop

A recipe is a complete flow, its trigger, steps and endings written out from the SDK's `Implement`, `Review`, `PullRequest` and `Hybrid` blocks. Recipes come in recipe packages that a repo installs in `.chernabog/`: Chernabog's own are `@chernabog/recipes`, released on their own cadence, and a company can publish its own. A repo copies a recipe into `.chernabog/flows/`, and the file is the repo's code from then on: read it, edit it, reorder its steps. Or it imports the recipe with `flows.<name>.from` in `config.yaml`, and the flow runs from the package, owned by the team that publishes it. `chernabog init` offers them, and `chernabog recipes add <name>` (or `--import`) adds one to a repo that's already set up. `chernabog recipes list` shows which the repo has, `chernabog recipes diff` how its copies differ from the versions they came from, and `chernabog recipes update` merges a package's later changes into them. Each has [a page in the docs](https://dataquail.github.io/chernabog/recipes/). The names of a recipe's steps are the keys a run in flight resumes by, so they're part of a recipe package's public API.

Five recipes make the review loop: `implement`, `review`, `re-review`, `address-review` and `resolve-conflicts`. They hand pull requests to each other through GitHub's own review requests and reviews; labels are the public record people see, and a few flows trigger on them.

| Label                      | Set by                      | Means                                                                                     |
| -------------------------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| `auto:eligible`            | a person                    | Queued; `implement` claims the oldest                                                     |
| `auto:ship`                | a person, `implement`       | Queued on the automated path; on a pull request, chernabog merges it once approved        |
| `auto:in-progress`         | `implement`, `Hybrid.claim` | A run owns the issue                                                                      |
| `auto:needs-review`        | `implement`                 | Open and green, with no reviewer in the pool; a person reviews                            |
| `auto:needs-human`         | any flow                    | A loop cap or a rule stopped it; no flow picks it up again                                |
| `auto:needs-clarification` | `implement`                 | Questions are on the issue; answer them and requeue                                       |
| `hybrid`                   | `Hybrid.openPullRequest`    | On a pull request: a person worked on it with an agent; a person merges. No flow reads it |

`auto:approved`, `auto:stale` and `auto:changes-requested` are still created, for flows of your own; the recipes don't set them.

`reviewers: [alice, data-quail]` in the team's `config.yaml` is the reviewer pool. Every login in it needs write access to the repo, since the reviewer merges on the automated path.

- **`implement`** claims the oldest issue labelled `auto:eligible` or `auto:ship`, lets the agent implement it test first in a worktree, runs the local gate (sending the agent back on failure, up to `limits.localGateRounds`), opens the pull request (labelled `auto:ship` for an `auto:ship` issue), waits for CI (fixing red, up to `limits.ciRounds`) and asks one reviewer from the pool, at random and never the author, to review it. Without a pool it labels the pull request `auto:needs-review` for a person.
- **`review`** runs as the persona whose review is requested, on a pull request it hasn't reviewed yet. It reviews in a read-only checkout, in a fresh session of the reviewer role (so Codex can review what Claude wrote), and posts a real GitHub review. An approval merges an `auto:ship` pull request with `PullRequest.merge`, which merges only when that's safe and otherwise labels it `auto:needs-human`, except that a merge GitHub refuses because the pull request conflicts with its base is left for `resolve-conflicts`; any other pull request is left for a person to merge. A request for changes goes to the author's `address-review`.
- **`re-review`** runs as a persona asked again on a pull request it already reviewed. It resumes its own review session, posts which findings are remediated, and approves (merging an `auto:ship` pull request the same way, leaving a conflicting one to `resolve-conflicts`) or hands the pull request to a person. `limits.reviewRounds` (default 1) caps the re-reviews, and it leaves pull requests labelled `auto:needs-human` alone.
- **`address-review`** runs as the persona that wrote the pull request, when its latest review requests changes and nothing has been pushed since. It resumes the session that implemented the pull request and has it consider the findings first; on a pull request from the hybrid path, that is the person's session, reopened in front of them, so they weigh and answer the review together. If it disagrees, it posts its reasons and hands the pull request to a person with `auto:needs-human`, without pushing or asking the reviewer again. Otherwise it makes and commits the changes, runs the local gate, pushes, waits for CI (fixing red, up to `limits.ciRounds`) and asks the reviewer who requested the changes to review again, which starts `re-review`. Anything else that stops it hands the pull request to a person.
- **`resolve-conflicts`** runs as the persona that wrote a pull request GitHub says conflicts with its base (`mergeable_state` `dirty`), which GitHub would otherwise neither run CI on nor merge. The agent merges the base into the branch (never a rebase), resolves the conflicts and commits; it then runs the local gate, pushes, comments what it resolved and waits for CI. When the latest decisive review is an approval, it asks that reviewer again, whose `re-review` merges an `auto:ship` pull request; that re-review counts against `limits.reviewRounds`. A conflict only a person can settle hands the pull request to a person. A repo that baked `review` or `re-review` before it keeps handing conflicting approvals to a person until it brings that change over with `chernabog recipes diff review re-review`.

Chernabog merges only pull requests labelled `auto:ship`; anything else, a `hybrid` pull request or a missing or misspelt label included, is merged by a person.

## The hybrid path

For work that needs a person through planning and implementation, a repo bakes the `human-initiated` recipe: `chernabog recipes add human-initiated`. The SDK's `Hybrid` blocks (`trigger`, `itemFor`, `claim`, `workWithPerson`, `personSession`, `openPullRequest`, `handOff`) make it, around `Implement`'s worktree, local gate, push and CI steps. `chernabog start <issue>` runs it on the issue, whatever its labels; its trigger finds nothing, so it never runs on a schedule. It claims the issue (`auto/issue-<n>`, taking it out of `auto:eligible` and `auto:ship`, and leaving alone a branch an unattended run claimed), prepares the worktree and opens a Claude session under the launcher, in front of the person, from the `human-initiated` prompt. They plan and implement together. When the agent thinks the work is done it drafts the pull request with `chernabog open-pr --draft` and asks the person whether to open it; their Yes, acted on by a hook rather than the agent, ends the session (the person can also run `chernabog open-pr` themselves); the flow then runs the local gate, pushes, opens the pull request labelled `hybrid`, waits for CI (fixes go back to the person's session) and asks one reviewer from the pool. If the person closes the session before `open-pr`, the run fails and keeps the claim; `chernabog start` on the issue again takes it over and resumes the same session. A repo without a `human-initiated` flow gets an error from `chernabog start` that says so, and names the recipe.

## The live view

`chernabog` with no arguments opens a live view of the daemon: each repo and its flows with their next tick and what the last tick found queued, account usage against the usage gate's thresholds, runs (one row per piece of work: an issue, the pull request opened for it and that pull request's reviews) with what each is about and its current step, and why recent ticks were skipped. With several repos or personas, project tabs and a persona filter narrow it.

| Key                 | Does                                                                                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tab`, `↑` `↓`      | Switch between the flows and the runs, and select                                                                                                                                                                                                                                           |
| `enter`             | On a run: its detail, with the steps it has taken and the time in each, the worktree it uses, the signal a parked run waits on, and the other runs of its thread; there `l` follows its log and `enter` opens a thread's run. On a flow: its persona's settings for the repo (below)        |
| `space`             | Open or close the selected run's thread, to show its other runs                                                                                                                                                                                                                             |
| `1`–`9` `0` `[` `]` | Pick a project tab (`0` is All), or cycle through them                                                                                                                                                                                                                                      |
| `@`                 | Cycle the persona filter                                                                                                                                                                                                                                                                    |
| `a`                 | Attach: bring up the run's agent session, to watch or step in. A session still running under a launcher comes up there (its Orca tab, `tmux attach`); otherwise it opens in the agent's own interactive UI (`claude --resume`, `codex resume`) in its worktree; exit the agent to come back |
| `x`                 | Cancel the selected run in flight, once you confirm with `y`: as `chernabog cancel`, leaving its agent sessions open                                                                                                                                                                        |
| `t`                 | Trigger the selected flow now, with its gates                                                                                                                                                                                                                                               |
| `e`                 | Turn the selected flow off or on for the persona it runs as, in machine config; it shows as pending until the daemon restarts on it, once idle                                                                                                                                              |
| `p`                 | Pause or resume the repo                                                                                                                                                                                                                                                                    |
| `q`                 | Quit                                                                                                                                                                                                                                                                                        |

**Settings.** `enter` on a flow opens that persona's settings for the repo: each of its flows with its schedule next to the team's, then its account and each role's. There, `e` turns a flow on or off; `s` types a schedule (cron) for it, checked before it's saved; `enter` on the account or a role chooses one from machine config's accounts; and `c` clears an override, back to the team's schedule or the default account. Each change goes to the repo's entry in machine config (the persona's own, where it has one), keeping its comments, and the daemon picks it up when idle. An account that would clash with the persona's others, such as a second account on one agent, is refused and nothing is written.

The view never runs work itself; it reads the daemon's state over its socket. `chernabog attach <run>` does the same attach from the command line.

## Commands

| Command                                                                         | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                                                                        | Repos, their schedules and trust, runs in flight, recent runs and why ticks were skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `run <flow> --repo <name>`                                                      | One run now, skipping gates, through the daemon; follows its log. `--detach` returns at once                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `trigger <flow> --repo <name>`                                                  | A tick now, with its gates, as if the schedule came due                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cancel <run>`, `cancel <repo> <item> [--flow <f>] [--as <login>]`              | Ends a run in flight for good, whether it waits or is mid-step: its workflow stops and never resumes, it's recorded as `cancelled` (who, when), and its worktrees and claim go: `auto:in-progress` and the assignment come off its issue, and the claim branch is deleted unless it has commits or a pull request. Work it can't safely remove is left and named. It never comments, reviews or touches a pull request. Agent sessions stay open unless `--close-session`, which closes them through their launcher. Works with the daemon running or stopped |
| `start <issue> [--repo <name>] [--as <login>]`                                  | The hybrid path: runs the repo's `human-initiated` flow on the issue through the daemon, which must be running, and brings its session up here (the Orca tab, `tmux attach`). `--repo` defaults to the enrolled repo this directory is in, else the only one. On an issue whose run is in flight, it brings up that session                                                                                                                                                                                                                                   |
| `open-pr --title <t> [--body <b> \| --body-file <f>] [--summary <s>] [--draft]` | From inside the session `chernabog start` opened: checks the worktree is clean and hands the work back; chernabog runs the local gate, pushes, opens the pull request, waits for CI and asks a reviewer. The session stays open for you to close. `--draft`, which the agent uses, keeps it as a draft and prints a Yes/No question for the agent to ask you; your Yes hands it over                                                                                                                                                                          |
| `logs <run> [-f]`                                                               | A run's log                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pause <repo>`, `resume <repo>`                                                 | Start no new runs in a repo; runs in flight continue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `trust [repo]`                                                                  | Shows what changed in `.chernabog/` since it was last trusted, and trusts it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `labels [repo]`                                                                 | Creates or corrects the repo's labels                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `doctor`                                                                        | Checks logins, gh scopes, labels, trust, each repo's launcher, that each reviewer this machine acts as can merge, and the daemon                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `setup`                                                                         | Chooses the GitHub personas this machine acts as and adds AI accounts (`--persona a,b`, `--account dir[:agent],…` without asking); safe to run again                                                                                                                                                                                                                                                                                                                                                                                                          |
| `recipes list`, `recipes add [names…]`, `recipes diff [names…]`                 | Lists the recipes of each recipe package installed in `.chernabog/`, with a check by each the repo copied and an arrow by each it imports; copies recipes into the repo's `.chernabog/`, asking which when none is named, never overwriting a file it has, and recording the version each came from (`--import` imports them instead); shows how the repo's copies differ from the versions they came from                                                                                                                                                    |
| `recipes update [names…]`, `recipes eject <flow>`                               | Moves each recipe package to its newest version for the repo's SDK and merges its changes into the copied recipes, keeping the repo's edits and marking conflicts; copies an imported flow into the repo and removes its `from`                                                                                                                                                                                                                                                                                                                               |
| `recipes upgrade`                                                               | Moves the repo's `.chernabog/` onto this Chernabog's core and the SDK released with it, in the working tree, committing nothing: `@chernabog/sdk` moves in `dependencies`, the `@chernabog/core` and `effect` pins move, the copied recipes move to the newest versions for that SDK (merging into edits, as `recipes update` does), and hand-written flows and steps are listed, with what each imports from core that core doesn't have                                                                                                                     |
| `init`, `enroll`                                                                | `init` scaffolds `.chernabog/`, installs `@chernabog/recipes` there, copies the recipes chosen (`--recipes a,b` without asking; none piped) and enrolls the repo once it has a flow; `enroll` only enrolls it: which personas work in it, which flows each runs and which accounts they spend (`--persona`, `--flows a,b`, `--defaults`, `--account` without asking)                                                                                                                                                                                          |
| `unenroll <repo>`                                                               | Removes a repo, and its settings, from this machine's config                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `install`, `uninstall`, `start`, `stop`, `daemon`                               | The daemon and its service; `install` runs `setup` first, and takes its flags. `start` with no issue starts the daemon                                                                                                                                                                                                                                                                                                                                                                                                                                        |

`run --from-checkout` runs in the foreground with the working copy's `.chernabog/`, to try a change to a flow before merging it; it needs the daemon stopped, since only one process may run the workflow engine. `labels --from-checkout` likewise creates the labels from the working copy, so issues can be queued while the setup is still in review.

## Agents

No flow depends on a specific agent. The SDK's `Agent` service calls an adapter, which starts or resumes a session in the worktree and returns the agent's final answer, checked against a JSON Schema.

| Adapter    | Start                                                                                                                                                                                        | Resume                       | Answer                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `claude`   | Under a [launcher](#launchers): an interactive `claude --session-id <id> --permission-mode auto`. Headless: `claude -p --session-id <id> --permission-mode auto --output-format stream-json` | `--resume <id>`              | Under a launcher: a JSON file the agent writes, checked by a Stop hook. Headless: `--json-schema` |
| `codex`    | `codex exec --json --approve-for-me`, sandboxed to the workspace (with network, and the repo's `.git` writable for commits)                                                                  | `codex exec resume <thread>` | `--output-schema`, `-o`                                                                           |
| `opencode` | `opencode run --format json`                                                                                                                                                                 | `--session <id>`             | the last JSON object in its final message                                                         |
| your own   | `agents.<name>.start` in machine config, with `{prompt}`, `{promptFile}`, `{sessionId}`, `{cwd}`                                                                                             | `agents.<name>.resume`       | the last JSON object it prints                                                                    |

Each piece of work has a stable session id, so a run that crashes mid-agent resumes the same session. Claude takes the id as given; Codex and opencode pick their own, which Chernabog records the moment they report it.

Each account in machine config belongs to one agent (`agent: codex`; `claude` by default) and the repo's account decides which agent implements; `agent` in the repo's config overrides it, and `agent` on the repo's entry in machine config overrides that. A flow can name a different adapter for one step, such as a Codex review of a Claude pull request, which then runs under that agent's account.

- **Usage gate.** Claude's comes from its usage endpoint, Codex's from the rate limits its own sessions log under `$CODEX_HOME/sessions`. opencode reports none, so its runs aren't gated on usage.
- **Accounts.** A run refuses to start when the account is logged in as anyone but its `expectedEmail`, or Codex is logged in with an API key. API keys are removed from every agent's environment, so runs can't fall back to pay-per-token billing.
- **Permissions.** Claude runs in auto mode, Codex with automatic approval review inside its workspace sandbox. opencode's `--auto` approves everything not explicitly denied, so it is off unless you add it: `agents: { opencode: { args: [--auto] } }`.

```yaml
# ~/.config/chernabog/config.yaml
accounts:
  personal: { configDir: ~/.claude-personal, expectedEmail: you@example.com }
  codex: { agent: codex, configDir: ~/.codex }
agents:
  aider:
    start: [aider, --yes-always, --message-file, "{promptFile}"]
```

## Launchers

A launcher decides where an interactive Claude session runs. Nothing runs `claude -p` unless the launcher is `headless`.

| Launcher   | A session is                                                     | Attach                                   |
| ---------- | ---------------------------------------------------------------- | ---------------------------------------- |
| `orca`     | A terminal tab in Orca, on the worktree (`orca terminal create`) | `orca terminal switch` brings the tab up |
| `tmux`     | A detached tmux session, `chernabog-<session>`                   | `tmux attach-session`                    |
| `headless` | `claude -p`, a child process of the run                          | `claude --resume`                        |
| your own   | `launchers.<name>` in machine config                             | its `attach`, if it has one              |

Under a launcher, the prompt asks the agent to write its final answer as JSON to a file and stop. A Stop hook checks that file against the answer's schema: until it is valid, the hook sends the agent back to write it, three times at most, and then the run fails. So whether the session is done is decided the same way under every launcher, and an answer can't be lost to a later turn. When the session is done, Chernabog closes it. If it ends without an answer, Chernabog resumes it twice before failing. A session still running when the daemon restarts is waited on again, never started twice. The run log follows the session's transcript.

The usage gate refreshes an expired login token the same way: a one-line session under the repo's launcher, closed once the token is fresh.

On the hybrid path a person works in the session with the agent. That needs Claude under a launcher; headless, or another agent, fails the run. The prompt says a person is there, the Stop hook never sends the agent back, the session stays open after it answers for the person to close (the next call on it closes it first), and a session the person closes before answering fails the run instead of being resumed.

Only Claude has an interactive mode. Codex, opencode and agents of your own run headless under any launcher, and `status` says so.

**Who chooses.** The launcher describes a person's own machine, so their choice beats the team's default: the repo's entry in machine config (or its persona's), then machine config's top-level `launcher`, then the repo's `launcher`, then `headless`. A team limits the choice with `allowedLaunchers`. A launcher outside that list fails the repo, naming the layer that chose it; Chernabog never falls back to another launcher.

```yaml
# .chernabog/config.yaml (team): Orca by default; tmux and headless also allowed
launcher: orca
allowedLaunchers: [orca, tmux, headless]
```

```yaml
# ~/.config/chernabog/config.yaml (one developer): tmux, except Orca for my-app
launcher: tmux
repos:
  - { repo: you/my-app, path: ~/code/my-app, launcher: orca }
```

**Your own launcher.** Only machine config can define one; a repo can name launchers and limit them, but it can't define commands that run in your terminal setup. Templates fill in `{command}` (the whole command, quoted for a shell), `{cwd}`, `{title}` and `{handle}`. `start` prints the session's handle, or nothing to make `{title}` the handle. `close` is required. `alive` (exit 0 while the session runs) and `attach` are optional; without `alive`, a session counts as running until it is done.

```yaml
# ~/.config/chernabog/config.yaml
launcher: wezterm
launchers:
  wezterm:
    start: [wezterm, cli, spawn, --cwd, "{cwd}", --, sh, -c, "{command}"]
    close: [wezterm, cli, kill-pane, --pane-id, "{handle}"]
```

Every launcher runs the same short command, `chernabog __launch <spec>`, which starts Claude in the terminal with its account's environment and the prompt from a file. An interactive session stops at "Do you trust this folder?" in a folder Claude doesn't trust yet; worktrees inherit the trust of the checkout they come from, so trust the checkout once (or a folder above it). `doctor` checks this, and that the launcher's tool works.

## The daemon

One daemon per machine schedules every enrolled repo, runs the workflow engine (its journal in `~/.config/chernabog/state.db`), and serves the CLI over a local socket. A lock file next to the database keeps a second engine from starting. Each step a team writes runs in a child process, so a step that crashes or hangs fails only its own activity.

The daemon checks machine config's enrolled repos every ten seconds and, when they change, restarts on them once nothing is executing, as it does after `trust`. So a repo `enroll` adds, one dropped or moved, or a flow turned on or off for a persona, is picked up without a restart by hand. A repo whose checkout is gone shows as `missing` (`checkout missing at <path>`) and starts no runs; its settings stay, and the daemon picks it up again when the checkout is back, or when `chernabog init` at the checkout's new place points the entry there.

Before starting a run, the daemon checks the machine's limits (global concurrency, quiet hours, the repo's active hours, pauses) and then the flow's own gate, such as the usage gate. A run waiting on a signal holds no slot. Every skipped tick is recorded with its reason; `status` shows the latest.

When its own binary changes, as `brew upgrade` changes it, the daemon drains: it starts no new runs, `status` and the live view say it's draining, and it restarts on the new binary once the runs executing now finish. Runs parked on a signal (a review that may take days) don't hold it up; the new binary decides whether each can resume.

The daemon logs to `~/.config/chernabog/daemon.log`, and each run to `~/.config/chernabog/runs/<run>.log`.

## Trust

The daemon runs committed flows and steps unattended, so anyone who can change `.chernabog/` can run code on your machine. Four rules contain that:

- Flows, steps and prompts are read from the base branch, never from the branch or worktree under work, so a pull request can't rewrite the flow that handles it.
- The packages they import are the ones `.chernabog/package.json` and its lockfile name, installed without install scripts into the base branch's snapshot, so trusting the tree trusts their versions too. Nothing resolves from the checkout's own `node_modules`.
- `chernabog trust` records the tree hash of the base branch's `.chernabog/`. When it changes after a pull, that repo starts no new runs until you review the change and trust it again, as with `direnv allow`. Trusting restarts the daemon on the new config once nothing is executing.
- Decisions that belong to a person stay with a person: `humanOnly` goes into every agent prompt, and an unattended run whose change touches `humanOnlyPaths` goes to `auto:needs-human` instead of a pull request. A person's session on the hybrid path (`chernabog start`, and `address-review` on its pull request) may push such a change, since the person watched it written; chernabog never merges one, whichever path opened it. A push that changes `.github/workflows/` needs a token with the `workflow` scope, which `gh auth login` grants; without it the run goes to `auto:needs-human` and says so.

Agents keep running with the permissions their own CLI config grants; Chernabog runs Claude Code in auto mode and doesn't widen them.

## Configuration

Config has two layers: the team's, committed in the repo, and each person's, in machine config. Later layers override earlier ones key by key, except that a repo can never raise machine limits, and the launcher, where a person's choice wins within the repo's `allowedLaunchers` (see [Launchers](#launchers)).

| Layer   | Lives in                          | Owns                                                                                                                                                                                                                                                                                                                                  |
| ------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo    | `.chernabog/`, committed          | Flows, steps, prompts, labels, `install`, `localGate`, `humanOnly`, `humanOnlyPaths`, `notes`, limits, default schedule, default launcher and `allowedLaunchers`, `runners`, `reviewers`, `assignee`, `reviewRequested`                                                                                                               |
| Machine | `~/.config/chernabog/config.yaml` | Agent accounts, usage thresholds, global concurrency, quiet hours, launcher for every repo, launchers of your own, GitHub personas, and the enrolled repos: for each, keyed by its `owner/name`, the flows that run and their settings, account, agent, roles, schedule, active hours, launcher and whether it's enabled, per persona |

`init` writes `config.schema.json` next to the YAML, so editors autocomplete it. It's generated, so `init` rewrites it whenever it's out of date; re-run it to pick up new keys. For a new `.chernabog/` it writes `package.json`, pinning `@chernabog/sdk` and `effect` at the binary's versions; after that the pins move only with `recipes upgrade` (see [Chernabog versions](#chernabog-versions)). It never overwrites any other file.

Flows, steps and prompts are read from the base branch, never from the branch or worktree under work, so a pull request can't rewrite the flow that handles it.

A flow runs on a machine only if the repo's entry in machine config lists it under `flows`. `init` and `enroll` write that list, offering the team's defaults: the flows `config.yaml` doesn't turn off with `flows.<flow>.enabled: false`, and whose `runners` (`runners: [alice]`, or `flows.<flow>.runners`) include one of the repo's personas, or this machine's `gh` login. So `runners` coordinates who spends their budget without restricting anyone: whoever lists a flow runs it. A flow listed with `enabled: false` is off but keeps its settings.

`flows.<flow>.assignee` and `flows.<flow>.reviewRequested` route work per item, like GitHub's `assignee:` and `review-requested:` qualifiers. Each takes `"@me"` (this machine's `gh` login), a login, `none`, or a list of these. `implement: { assignee: ["@me", none] }` takes your issues and unassigned ones; `review`, `re-review` and `address-review` need no filter: their triggers take only pull requests that request the review of the persona they run as, or, for `address-review`, that it wrote. The rest waits for those people's machines, and `status` shows it as assigned elsewhere.

```yaml
# ~/.config/chernabog/config.yaml
accounts:
  work: {}
  personal:
    configDir: ~/.claude-personal
    expectedEmail: you@example.com
usageGate:
  targetEndUsage: 0.95
  taskCostEstimate: 0.04
  fiveHourCeiling: 0.4
  humanRatePerHour: 0.005
concurrency: 1
repos:
  - repo: you/my-app # the key: settings follow the repo, not the folder
    path: ~/code/my-app # where its checkout is now
    account: personal
    baseBranch: main
    flows: # the flows that run here, and no others
      implement: {}
      review: { schedule: "*/20 * * * *" }
```

A repo's entry can also set `agent`, `accounts` (accounts for steps on other agents, one per agent, such as `[codex-personal]`; enrolling asks when an agent has several), `roles` (an account for a step's role, such as `{ reviewer: codex }`, which must run another agent than the entry's account), `schedule`, `activeHours`, `launcher` and `enabled: false`. With several GitHub personas, `personas:` maps each login to its own `flows`, `account` and the rest, each key replacing the repo entry's; see the [configuration reference](https://dataquail.github.io/chernabog/reference/configuration/). Two clones of one repo need a `name` (`enroll --name`) to keep them apart.

Upgrading from a version that read `.chernabog/local.yaml`, the first command you run moves its choices onto the repo's entry in machine config, and says what it moved on stderr. It leaves `local.yaml` in place; delete it once you've checked the result.

## Flows and steps

A flow is a TypeScript module in `.chernabog/flows/` whose default export is `defineFlow({ trigger, gate, concurrency, workflow })`. The trigger returns the work items in the state the flow acts on; the workflow is the durable work for one item. An optional `item(key)` finds the work item for a key a person names that the trigger doesn't report, for `run --item` and `chernabog start`. Each step in it is an activity whose result is saved in SQLite, so after a crash or restart the run resumes after the last completed step.

The `implement` recipe composes the SDK's `Implement` building blocks. Reorder them, leave one out, or put a step of your own between them with `step("name", input)`: either `.chernabog/stages/name.ts` exporting `defineStage({ input, output, run })`, or an executable `name` that reads JSON on stdin and prints JSON. Each step runs in its own process; exit 0 continues, 78 skips the run, anything else fails it. A step that crashes partway runs again, so every step must be safe to repeat.

`.chernabog/` is a package of its own, the same in every repo whatever its language. Its flows are written from `@chernabog/sdk`, which `package.json` lists in `dependencies` at the version the repo chooses; `@chernabog/core` and `effect` it pins as dev dependencies at the versions the binary bundles, and `tsconfig.json` types the flows against them. At runtime the binary always supplies its own copies of core and `effect`, to every module that imports them, the installed SDK included. The SDK, and anything else a flow or step imports, goes in `dependencies`, with the lockfile committed: the daemon installs them into each snapshot of the base branch, using the binary as `bun install --production --frozen-lockfile --ignore-scripts`, so the machine needs no Node or package manager. `doctor` flags pins that have drifted from the binary; `recipes upgrade` moves them.

### Chernabog versions

One binary runs every repo enrolled on a machine, and each repo's flows were written against whichever SDK was current when someone last moved them. So the binary doesn't run the repo's SDK for it: each repo installs the `@chernabog/sdk` it pins, and two repos on different SDKs run side by side. What the binary provides is `@chernabog/core`, the contract between it and every flow: the flow shape, the durable steps, the services, claims and markers. Within a major, core only grows ([ADR 0004](docs/adr/0004-core-abi.md)), so an upgrade of Chernabog keeps running the SDKs a repo already has. A repo's one version fact is the core range its installed SDK declares; the binary runs it when it provides a core in that range. `doctor` names what it provides.

A repo whose SDK needs a core outside that, that doesn't list the SDK in `dependencies`, or with a flow or step that imports from `@chernabog/core` something the binary's core doesn't export, is refused before anything in it is run, and every other repo keeps running. `status`, the live view and `doctor` show it as `incompatible`, saying which side is behind:

- **the repo is behind**: run `chernabog recipes upgrade` in its checkout, review the diff, and merge it. It moves the SDK to the one released with this Chernabog, the pins and the copied recipes, and lists the hand-written flows it can't move.
- **the binary is behind**: upgrade Chernabog.

`engines.chernabog`, the floor older releases wrote, is no longer read; a manifest that still has one is refused, and `recipes upgrade` removes it. Keys in `config.yaml` that the binary doesn't know fail the repo instead of being ignored: each is a typo or a setting from a newer Chernabog, and either may be a rule the team counts on.

**Local state.** Machine config (`config.yaml`) and `state.db` are stamped with the Chernabog that last migrated them. Before a newer binary migrates either one, it keeps a copy in `~/.config/chernabog/backups/`, named for the version it came from (`config.yaml.0.9.0`, `state.db.0.9.0`; `before-<version>` for one from before stamps), and says where. The newest three of each are kept. A binary that finds a stamp newer than itself refuses to read the file, and says how to restore its copy. There are no down migrations.

**Runs.** Each run records the `.chernabog/` tree it started from and the core it started under. A run in flight resumes against that tree's snapshot, with the SDK that tree pinned, so a merge to `.chernabog/` never swaps the code under it. One that started under a core the binary can't resume (another major, or a later version than it has) is never resumed: at startup it goes to `needs-human`, with a summary naming both versions, and its worktrees and claim are released as `cancel` releases them, so its work can start again.

**Rolling back.** Install the older binary, stop the daemon (`chernabog stop`), restore the copies it left (`cp ~/.config/chernabog/backups/config.yaml.<version> ~/.config/chernabog/config.yaml`, and the same for `state.db`), then `chernabog start`. Whatever happened after the upgrade, such as runs it recorded, is lost with the newer files.

See [`packages/sdk`](packages/sdk/README.md) for the blocks and helpers, and [`packages/core`](packages/core/README.md) for the contract they're written against.

## License

[MIT](LICENSE). The lint plugins vendored under `tools/oxlint/` keep their own licenses, next to them.
