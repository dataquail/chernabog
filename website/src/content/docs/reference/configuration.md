---
title: Configuration
description: Every key in the repo, personal and machine config layers.
---

| Layer    | File                              | Committed | Owns                                       |
| -------- | --------------------------------- | --------- | ------------------------------------------ |
| Repo     | `.chernabog/config.yaml`          | yes       | what work gets done, and how               |
| Personal | `.chernabog/local.yaml`           | no        | when it runs for you, and with which agent |
| Machine  | `~/.config/chernabog/config.yaml` | —         | accounts, budget, limits, enrolled repos   |

Later layers override earlier ones key by key, with two exceptions: a repo can never raise machine limits, and the [launcher](/chernabog/agents/launchers/#who-chooses) is a person's choice within the repo's `allowedLaunchers`. `init` writes `config.schema.json` and `local.schema.json` beside the YAML for editor autocomplete. Unknown keys fail the repo.

Durations are `<n> <unit>`: `90 minutes`, `6 hours`, `2 days`. Hours are `HH:MM-HH:MM`, local time, and may wrap midnight.

## Repo

| Key                | Default                    | Meaning                                                                  |
| ------------------ | -------------------------- | ------------------------------------------------------------------------ |
| `baseBranch`       | `main`                     | branch flows are read from and pull requests target                       |
| `install`          | none                       | command run in each fresh worktree; `null` for none                       |
| `localGate`        | `[]`                       | commands a change must pass before its pull request opens                |
| `humanOnly`        | `[]`                       | decisions the agent must stop for; in every prompt                        |
| `humanOnlyPaths`   | `[]`                       | globs a change must not touch; one that does goes to `auto:needs-human`   |
| `notes`            | `[]`                       | repo facts the agent should know                                          |
| `labels.<key>`     | `auto:*`                   | rename a [label](/chernabog/work/flows/#labels)                           |
| `board`            | none                       | `{ projectNumber, readyStatus, inProgressStatus }`: queue only issues whose project Status is `readyStatus` |
| `reviewTrigger`    | none                       | comment posted on each new pull request, e.g. to summon a review bot      |
| `schedule`         | spread across the hour     | cron for every flow                                                       |
| `agent`            | the account's              | adapter that implements                                                   |
| `launcher`         | `headless`                 | the team's default launcher                                               |
| `allowedLaunchers` | any                        | launchers a person may choose                                             |
| `runners`          | anyone                     | GitHub logins whose machines run the flows; see [Runners](#runners)      |
| `flows.<flow>`     | —                          | `enabled`, `schedule`, `concurrency`, `agent`, `runners`, `assignee`, `reviewRequested` for one flow; see [Routing by assignee and reviewer](#routing-by-assignee-and-reviewer) |
| `limits.localGateRounds` | `2`                  | times the agent is sent back for a failing local gate                    |
| `limits.ciRounds`  | `3`                        | times it is sent back for red CI                                          |
| `limits.reviewRounds` | `3`                     | reviews of one pull request before `auto:needs-human`                    |
| `limits.staleAfter`| `6 hours`                  | wait for a push after changes are requested, before `auto:stale`          |
| `limits.ciTimeout` | `2 hours`                  | wait for CI to finish                                                     |

`launchers` is refused here: only machine config defines launcher commands.

### Runners

`runners` names the GitHub logins whose machines run the repo's flows by default; `flows.<flow>.runners` names them for one flow, over the repo's. Unset, every enrolled machine runs them. On any other machine the flow is off, and `status` says why: `off, not a runner (runners: alice; this machine is bob)`. A machine's login is the one its `gh` token belongs to, looked up when the daemon starts; `doctor` shows it, and which flows it isn't a runner of.

It's coordination, not access control: whoever enrolls the repo can still run a flow, by setting `flows.<flow>.enabled: true` in their `local.yaml`, for instance to cover for a runner who is away. A flow the team turns off with `flows.<flow>.enabled: false` stays off for runners too. Claims are race-safe without it: two machines never implement the same issue.

```yaml
# .chernabog/config.yaml
runners: [alice]
flows:
  review: { runners: [alice, bob] }
```

### Routing by assignee and reviewer

`flows.<flow>.assignee` and `flows.<flow>.reviewRequested` make a machine start only the work items for certain people. They work like GitHub's `assignee:` and `review-requested:` search qualifiers. Each takes one value or a list:

- `@me`: this machine's GitHub login, the one its `gh` token belongs to
- a login, such as `alice`
- `none`: nobody

An item starts if anyone on the list matches. When a flow sets both filters, an item must pass both. Logins are compared case-insensitively. When the machine's login can't be looked up, `@me` matches no one.

`implement` items carry the issue's assignees. `review` items carry the pull request's assignees and its requested reviewers. Teams requested as reviewers don't count, so a pull request that only requests a team has no requested reviewers. A custom flow's items match only `none` unless its trigger sets `assignees` or `reviewers` on them.

Items that don't match are left for other machines. `status` lists them (`assigned elsewhere: issue-12 (assignee: alice)`) and the live view counts them. When nothing else is queued, the tick's skip reason is `only work for others: …`. A run already going still hears about its item, so a review keeps waking on pushes even after GitHub drops this machine from the requested reviewers. Naming an item, as in `chernabog run implement --item issue-12`, runs it here whoever it's for.

`runners` and `enabled` decide first whether the flow runs on a machine at all. An issue assigned to someone the flow is off for waits until they turn it on in their `local.yaml`. The claim branch still keeps two machines from implementing the same issue.

```yaml
# .chernabog/config.yaml
flows:
  implement: { assignee: ["@me", none] }   # my issues, and unassigned ones
  review: { reviewRequested: "@me" }       # pull requests requesting my review
```

Both can go in `local.yaml` too. Use them to take only your own work, to cover for a teammate (`assignee: alice`), or set `null` to clear the team's filter. Quote `"@me"` in YAML, since a bare `@` can't start a value.

```yaml
# .chernabog/config.yaml
baseBranch: main
install: pnpm install --frozen-lockfile
localGate: [pnpm lint, pnpm test]
humanOnlyPaths: [.github/**]
flows:
  review: { agent: codex }
limits: { reviewRounds: 2, staleAfter: 1 day }
```

## Personal

| Key            | Meaning                                                       |
| -------------- | ------------------------------------------------------------- |
| `enabled`      | `false` stops every flow in this repo, for you                |
| `schedule`     | cron for every flow, over every schedule the repo sets        |
| `activeHours`  | start runs only within these hours                            |
| `agent`        | adapter that implements, over the repo's                      |
| `launcher`     | your launcher for this repo; wins over every other layer      |
| `flows.<flow>` | `enabled`, `schedule`, `concurrency`, `agent`, `assignee`, `reviewRequested` for one flow; `enabled: true` runs it here even when you aren't one of its runners |

```yaml
# .chernabog/local.yaml
enabled: true
activeHours: "09:00-18:00"
launcher: orca
flows:
  review: { enabled: false }
```

## Machine

| Key                     | Default      | Meaning                                                           |
| ----------------------- | ------------ | ----------------------------------------------------------------- |
| `accounts.<name>`       | —            | `configDir`, `expectedEmail`, `oauthTokenEnv`, `usageGate` (`none` to run ungated), `agent` (default `claude`) |
| `usageGate`             | see [the gate](/chernabog/agents/usage-gate/) | all four thresholds, or none            |
| `concurrency`           | `1`          | runs at once on this machine; caps every repo and flow            |
| `quietHours`            | none         | start no runs within these hours                                  |
| `humanOnly`             | `[]`         | decisions every repo's agent must stop for                        |
| `agents.<name>`         | —            | `args` for a built-in adapter; `start`, `resume` for [your own](/chernabog/agents/adapters/#your-own-agent) |
| `launcher`              | —            | your launcher for every repo                                      |
| `launchers.<name>`      | —            | `start`, `close`, `alive`, `attach`: [your own](/chernabog/agents/launchers/#your-own-launcher) |
| `repos[]`               | —            | `path`, `repo` (`owner/name`), `name`, `account`, `baseBranch`; written by `enroll` |

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
  - { path: ~/code/my-app, repo: you/my-app, account: personal, baseBranch: main }
```
