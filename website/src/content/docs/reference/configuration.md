---
title: Configuration
description: Every key in the repo and machine config layers.
---

| Layer    | File                              | Committed | Owns                                       |
| -------- | --------------------------------- | --------- | ------------------------------------------ |
| Repo     | `.chernabog/config.yaml`          | yes       | what work gets done, and how               |
| Machine  | `~/.config/chernabog/config.yaml` | —         | accounts, budget, limits, and for each enrolled repo which flows run as each persona, when, and with which account |

Later layers override earlier ones key by key, with two exceptions: a repo can never raise machine limits, and the [launcher](/chernabog/agents/launchers/#who-chooses) is a person's choice within the repo's `allowedLaunchers`. `init` writes `config.schema.json` beside the YAML for editor autocomplete, and `rehearsal.schema.json` for [scenarios](/chernabog/flows/rehearsing/). Unknown keys fail the repo.

Durations are `<n> <unit>`: `90 minutes`, `6 hours`, `2 days`. Hours are `HH:MM-HH:MM`, local time, and may wrap midnight.

## Repo

| Key                | Default                    | Meaning                                                                  |
| ------------------ | -------------------------- | ------------------------------------------------------------------------ |
| `baseBranch`       | `main`                     | branch flows are read from and pull requests target                       |
| `install`          | none                       | command run in each fresh worktree; `null` for none                       |
| `localGate`        | `[]`                       | commands a change must pass before its pull request opens                |
| `humanOnly`        | `[]`                       | decisions the agent must stop for; in every prompt                        |
| `humanOnlyPaths`   | `[]`                       | globs an unattended run's change must not touch, which then goes to `auto:needs-human`; chernabog never merges a change to them. A person's [hybrid](/chernabog/recipes/human-initiated/) session may push one ([Trust](/chernabog/operate/trust/)) |
| `notes`            | `[]`                       | repo facts the agent should know                                          |
| `labels.<key>`     | `auto:*`, and `hybrid`     | rename a [label](/chernabog/work/flows/#labels)                           |
| `board`            | none                       | `{ projectNumber, readyStatus, inProgressStatus }`: queue only issues whose project Status is `readyStatus` |
| `reviewTrigger`    | none                       | comment posted on each new pull request, e.g. to summon a review bot      |
| `schedule`         | spread across the hour     | cron for every flow but [manual ones](/chernabog/flows/flows/#manual-flows) |
| `agent`            | the account's              | adapter that implements                                                   |
| `launcher`         | `headless`                 | the team's default launcher                                               |
| `allowedLaunchers` | any                        | launchers a person may choose                                             |
| `runners`          | anyone                     | GitHub logins `enroll` offers the flows to; see [Runners](#runners)      |
| `reviewers`        | none                       | the reviewer pool, by GitHub login; see [Reviewers](#reviewers)          |
| `flows.<flow>`     | —                          | `enabled` (the default `enroll` offers), `schedule` (an error for a manual flow), `concurrency`, `agent`, `agents`, `runners`, `assignee`, `reviewRequested` for one flow; see [Agents by role](#agents-by-role) and [Routing by assignee and reviewer](#routing-by-assignee-and-reviewer) |
| `flows.<flow>.from` | —                         | Run this flow from a recipe package installed in `.chernabog/` (in `package.json`'s `dependencies`), as `"<package>/<recipe>"`, instead of a file in `flows/`; see [Copy or import](/chernabog/recipes/#copy-or-import). A flow with both is an error |
| `limits.localGateRounds` | `2`                  | times the agent is sent back for a failing local gate                    |
| `limits.ciRounds`  | `3`                        | times it is sent back for red CI                                          |
| `limits.reviewRounds` | `1`                     | re-reviews of one pull request before `re-review` hands it to a person (`auto:needs-human`) |
| `limits.staleAfter`| `6 hours`                  | a wait for flows of your own; the recipes don't read it         |
| `limits.ciTimeout` | `2 hours`                  | wait for CI to finish                                                     |
| `limits.eventTickMin` | `30 seconds`            | the least time between two [event ticks](/chernabog/operate/daemon/#ticks-on-events) of one persona's flow |
| `limits.validityEvery` | `5 minutes`           | how often the daemon asks each run in flight whether its work item is [still valid](/chernabog/flows/flows/#work-that-goes-away) |
| `limits.leaseTtl` | `12 hours`                   | how long a run's [claim](/chernabog/operate/daemon/#leases) lasts unless its daemon renews it, while the run executes |
| `limits.parkedLeaseTtl` | `3 days`               | the same, while the run is parked waiting on review, CI or a person |
| `limits.leaseRenewEvery` | `30 minutes`          | how often the daemon renews the leases of its runs in flight |
| `limits.planNodes` | `12`                       | tasks one plan may hold, its verify task aside ([`plan`](/chernabog/recipes/plan/)) |
| `limits.planRounds` | `2`                       | times the agent is sent back for a plan that fails its checks             |

`launchers` is refused here: only machine config defines launcher commands.

### Runners

`runners` names the GitHub logins who run the repo's flows by default; `flows.<flow>.runners` names them for one flow, over the repo's. Like `flows.<flow>.enabled`, it's a default, not a gate: `chernabog enroll` offers a flow among each persona's defaults only when the team doesn't turn it off and its runners, if any, include that [persona](#github-personas)'s login, or, without personas, this machine's `gh` login. What runs is what the repo's entry in machine config [lists](#which-flows-run).

It's coordination, not access control: whoever enrolls the repo can still pick a flow, for instance to cover for a runner who is away. Claims are race-safe without it: two machines never implement the same issue.

```yaml
# .chernabog/config.yaml
runners: [alice]
flows:
  review: { runners: [alice, bob] }
```

### Reviewers

`reviewers` names the team's reviewer pool. Once a pull request's CI is green, `implement` asks one of them, at random, to review it, never the pull request's author. The `review` flow then runs as that persona, and `re-review` when it's asked again; see [the review loop](/chernabog/work/flows/#the-reviewer-pool). Without a pool, or with only the author in it, the pull request is labelled `auto:needs-review` for a person.

On the automated path, an `auto:ship` pull request, the approving reviewer merges, so every login in `reviewers` needs write access to the repo. `chernabog doctor` checks it for each reviewer this machine acts as, from `github:` in machine config.

A review request for a login this machine doesn't act as waits for the machine that does. Nothing fails, so chernabog says so instead:

- `doctor` warns, for each persona that opens pull requests (it runs `implement`, `human-initiated`, or a flow that asks for a review), when no one in the pool but that persona is a login under `github:` here: `pull requests authored as alice go to data-quail, which this machine doesn't act as; they wait until another machine reviews them`. `enroll` notes the same when you choose those flows. It's a warning, since a teammate's machine may serve that login.
- `status` lists, under the `review` flow, the open pull requests that wait on such a login: `assigned elsewhere: #73 waits on data-quail (not on this machine)`. One drops off once that review is in.

```yaml
# .chernabog/config.yaml
reviewers: [alice, data-quail]
```

### Agents by role

`flows.<flow>.agent` sets the adapter for a whole flow. `flows.<flow>.agents` names adapters by role, for a flow whose steps play different parts, such as one that implements with Claude and reviews with Codex:

```yaml
# .chernabog/config.yaml
flows:
  review:
    agents: { reviewer: codex }
  re-review:
    agents: { reviewer: codex }
```

A step given a role, as in `Review.round(pr, 1, { role: "reviewer" })`, runs with that role's adapter. A step with no role, or a role the flow doesn't name, falls back to the flow's `agent` and then the repo's. The repo's entry in machine config can override one role and keep the team's others, with `flows.<flow>.agents`, or with `roles`, which picks an [account](#roles) for the role and so its agent. Each adapter runs under that agent's account in machine config.

### Routing by assignee and reviewer

`flows.<flow>.assignee` and `flows.<flow>.reviewRequested` make a machine start only the work items for certain people. They work like GitHub's `assignee:` and `review-requested:` search qualifiers. Each takes one value or a list:

- `@me`: this machine's GitHub login, the one its `gh` token belongs to, or the [persona](#github-personas) the flow runs as
- a login, such as `alice`
- `none`: nobody

An item starts if anyone on the list matches. When a flow sets both filters, an item must pass both. Logins are compared case-insensitively. When the machine's login can't be looked up, `@me` matches no one.

`implement` items carry the issue's assignees. `review` and `re-review` items carry the pull request's assignees and its requested reviewers; their triggers already take only pull requests that request the review of the persona they run as, so they need no `reviewRequested`. `address-review` items carry the pull request's assignees; its trigger takes only pull requests the persona wrote. Teams requested as reviewers don't count, so a pull request that only requests a team has no requested reviewers. A custom flow's items match only `none` unless its trigger sets `assignees` or `reviewers` on them.

Items that don't match are left for other machines. `status` lists them (`assigned elsewhere: issue-12 (assignee: alice)`) and the live view counts them. When nothing else is queued, the tick's skip reason is `only work for others: …`. A run already going still hears about its item. Naming an item, as in `chernabog run implement --item issue-12`, runs it here whoever it's for.

Whether the flow runs for a persona at all is decided first, by its [flows](#which-flows-run) in machine config. An issue assigned to someone the flow is off for waits until they turn it on. The claim branch still keeps two machines from implementing the same issue.

```yaml
# .chernabog/config.yaml
flows:
  implement: { assignee: ["@me", none] }   # my issues, and unassigned ones
  review: { reviewRequested: "@me" }       # pull requests requesting my review
```

Both can go in a flow's settings in machine config too. Use them to take only your own work, to cover for a teammate (`assignee: alice`), or set `null` to clear the team's filter. Quote `"@me"` in YAML, since a bare `@` can't start a value.

```yaml
# .chernabog/config.yaml
baseBranch: main
install: pnpm install --frozen-lockfile
localGate: [pnpm lint, pnpm test]
humanOnlyPaths: [.github/**]
flows:
  review: { agent: codex }
limits: { reviewRounds: 2 }
```

## Machine

| Key                     | Default      | Meaning                                                           |
| ----------------------- | ------------ | ----------------------------------------------------------------- |
| `github.<login>`        | —            | a GitHub persona this machine acts as, written by `chernabog setup`; see [GitHub personas](#github-personas) |
| `accounts.<name>`       | `work`, on `~/.claude` | `configDir`, `expectedEmail`, `oauthTokenEnv`, `usageGate` (`none` to run ungated), `agent` (default `claude`); `chernabog setup` adds them |
| `usageGate`             | see [the gate](/chernabog/agents/usage-gate/) | all four thresholds, or none            |
| `concurrency`           | `1`          | runs at once on this machine; caps every repo and flow            |
| `quietHours`            | none         | start no runs within these hours                                  |
| `events`                | `{ local: true, notifications: false }` | which [events](/chernabog/operate/daemon/#ticks-on-events) tick flows sooner than cron; `github.<login>.events` overrides it for one persona |
| `humanOnly`             | `[]`         | decisions every repo's agent must stop for                        |
| `agents.<name>`         | —            | `args` for a built-in adapter; `start`, `resume` for [your own](/chernabog/agents/adapters/#your-own-agent); `standIns`, `dir` and `exclusive` for [`rehearsal`](/chernabog/flows/rehearsing/#stand-ins) |
| `launcher`              | —            | your launcher for every repo                                      |
| `launchers.<name>`      | —            | `start`, `close`, `alive`, `attach`: [your own](/chernabog/agents/launchers/#your-own-launcher) |
| `repos[]`               | —            | the enrolled repos, written by `enroll`; see [Enrolled repos](#enrolled-repos) |

```yaml
# ~/.config/chernabog/config.yaml
accounts:
  work: {}
  personal: { configDir: ~/.claude-personal, expectedEmail: you@example.com }
  # A host with no Claude login of its own, such as CI: the token from `claude setup-token`, in this variable.
  # Such a token cannot read usage, so the account runs without the usage gate.
  ci: { oauthTokenEnv: CLAUDE_CODE_OAUTH_TOKEN, usageGate: none }
concurrency: 1
quietHours: "23:00-07:00"
repos:
  - repo: you/my-app
    path: ~/code/my-app
    account: personal
    baseBranch: main
    flows:
      implement: {}
      review: {}
```

### Enrolled repos

Each entry in `repos` is one repo this machine runs, with each person's choices for it. It's keyed by `repo`, so settings follow the repo rather than the folder: a worktree or a moved checkout doesn't lose them.

| Key            | Default         | Meaning                                                        |
| -------------- | --------------- | -------------------------------------------------------------- |
| `repo`         | —               | `owner/name` on GitHub: the key its settings follow            |
| `path`         | —               | where its checkout is now                                      |
| `name`         | the repo's name | a short name; keeps two clones of one repo apart (`enroll --name`) |
| `baseBranch`   | `main`          | the branch `.chernabog/` is trusted from, unless the repo sets its own |
| `account`      | the first account | whose budget its runs spend, from `accounts`                 |
| `agent`        | the repo's, else the account's | adapter that implements, over the repo's        |
| `accounts`     | each agent's first account | other accounts its runs use, at most one per agent, each on another agent than `account`'s; see [Roles](#roles) |
| `roles.<role>` | —               | an account for one role; see [Roles](#roles)                   |
| `flows.<flow>` | —               | the flows that run, and no others; see [Which flows run](#which-flows-run) |
| `schedule`     | —               | cron for every flow but manual ones, over every schedule the repo sets |
| `activeHours`  | —               | start runs only within these hours                             |
| `launcher`     | —               | your launcher for this repo; wins over every other layer       |
| `enabled`      | `true`          | `false` stops every flow in this repo                          |
| `personas.<login>` | —           | each persona's own choices; see [GitHub personas](#github-personas) |

`chernabog init` and `enroll` write `flows`, `account`, `accounts` and `personas` from what you [choose](/chernabog/start/set-up-a-repo/#enroll); the rest you edit by hand. `account` through `enabled` are the defaults every persona inherits. A persona's entry under `personas` takes the same keys, and each one it sets replaces the repo entry's whole: a persona with its own `flows` runs those, not the repo entry's plus its own.

When the checkout is gone, the daemon shows the repo as `missing` (`checkout missing at <path>`) and starts no runs; its settings stay. When the checkout comes back, the daemon picks it up again. `chernabog init` at a checkout's new place finds the entry for the same `repo` whose path is gone and, in a terminal, offers to point it there, keeping its settings. `chernabog unenroll <name|owner/name>` removes an entry and its settings.

### Which flows run

A flow runs for a persona only when its `flows` lists it, its own or the repo entry's it inherits. Every flow not listed is off, whatever the team's `config.yaml` says, and `status` says `flow turned off`. A listed flow with `enabled: false` is off too, but keeps its settings for when it's turned back on.

`chernabog init` and `enroll` write the list for each chosen persona, asking in a terminal or taking `--flows implement,review` or `--defaults`; piped, a persona keeps what it lists, and one with nothing listed gets the team's defaults, from `flows.<flow>.enabled` and [runners](#runners). A flow whose agent has no account in machine config can't be chosen. Re-enrolling keeps the settings of each flow still listed. `e` in the [live view](/chernabog/work/live-view/) turns one flow off or on for a persona.

A flow's settings take the keys of the repo's `flows.<flow>`, except `runners`: `schedule`, `concurrency`, `agent`, `agents`, `assignee`, `reviewRequested` and `enabled`. Each overrides the team's for that flow. A `schedule` for a manual flow is an error, here as in `config.yaml`.

### Roles

`roles` picks an account by role, such as `{ reviewer: codex-personal }`, for a role that needs another account than the persona's own. A step given that role runs with the account's agent, under that account, over the team's `flows.<flow>.agents`. Accounts are chosen by agent, so a role's account must run a different agent than the persona's own account; one on the same agent fails the repo.

`accounts` does the same for every step on an agent, rather than for one role: `accounts: [codex-personal]` runs every codex step under `codex-personal`. It lists at most one account per agent, none on the persona's own account's agent; a list that breaks either rule fails the repo. Unset, each agent uses its first account in machine config. Enrolling asks for one where the chosen flows need an agent with several accounts, and writes the answer here. Where `roles` names an account on the same agent, the role's account wins.

### Moving from local.yaml

Before, each person's choices lived in a gitignored `.chernabog/local.yaml` in the checkout, and `personas` was a list of logins. The first command you run after upgrading rewrites machine config, keeping its comments, and prints what it changed on stderr:

- a `personas: [a, b]` list becomes `personas: { a: {}, b: {} }`;
- for each repo entry that lists no flows anywhere, it lists the flows that ran there before (`local.yaml`'s choice, else the team's `flows.<flow>.enabled`, else its runners), on the repo entry, or per persona where they differ;
- `local.yaml`'s flow settings, and its `enabled`, `schedule`, `activeHours`, `agent` and `launcher`, move onto the repo entry, so every persona inherits them, as they applied to the whole checkout before.

It leaves `local.yaml` in place; nothing reads it any more, so delete it once you've checked the result.

### GitHub personas

Without `github:`, the daemon acts on GitHub as one account: `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh`'s active account. `github:` lists GitHub logins it acts as instead, each logged in to `gh` side by side (`gh auth login`, then `gh auth switch` back to your usual account). A persona's token always comes from `gh auth token --user <login>`; Chernabog never stores it.

A repo's `personas` maps each login that runs its flows to that persona's own choices. With one login under `github:`, that one is the default; with several, the repo must name them. Without `github:` there are no persona entries, and the repo entry's own settings run the one implicit account, so a `GH_TOKEN`-only host such as CI still works. Each persona then runs each flow on its own schedule, as itself: its trigger, its API calls, its pushes, its agent sessions and its steps all act as that login, and `@me` and `runners` mean it. `status` shows the flow as `review as bob`, and its runs as `demo/review pr-12 as bob`.

A flow several personas run should set `assignee` or `reviewRequested` to `@me`, so each persona takes only its own work; the daemon warns about one that sets neither, unless the flow says `ownWork: true` in `defineFlow`, as `review`, `re-review` and `address-review` do: their triggers take only the pull requests that request their own persona's review, or, for `address-review`, that it wrote. A [`human-initiated`](/chernabog/recipes/human-initiated/) flow says it too, since a person starts each of its runs. Pushes authenticate with the persona's token only over https; `doctor` checks each login and each origin.

```yaml
# ~/.config/chernabog/config.yaml
github:
  you: {}
  your-reviewer: { events: { notifications: true } }   # its review requests tick it within a minute
accounts:
  personal: { configDir: ~/.claude-personal, expectedEmail: you@example.com }
  codex-personal: { agent: codex, configDir: ~/.codex }
repos:
  - repo: you/my-app                    # the key; settings follow the repo, not the folder
    path: ~/code/my-app                 # where its checkout is now
    account: personal                   # defaults every persona inherits
    activeHours: "09:00-18:00"
    personas:
      you:
        flows:
          implement: { assignee: ["@me", none] }
          address-review: { schedule: "*/20 * * * *" }
      your-reviewer:
        roles: { reviewer: codex-personal }   # only where a role needs another account
        flows:
          review: {}
          re-review: {}
```

`chernabog run` and `trigger` take `--as <login>` for a flow that runs as several personas.
