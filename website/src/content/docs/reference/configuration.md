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
| `flows.<flow>`     | —                          | `enabled`, `schedule`, `concurrency`, `agent` for one flow                |
| `limits.localGateRounds` | `2`                  | times the agent is sent back for a failing local gate                    |
| `limits.ciRounds`  | `3`                        | times it is sent back for red CI                                          |
| `limits.reviewRounds` | `3`                     | reviews of one pull request before `auto:needs-human`                    |
| `limits.staleAfter`| `6 hours`                  | wait for a push after changes are requested, before `auto:stale`          |
| `limits.ciTimeout` | `2 hours`                  | wait for CI to finish                                                     |

`launchers` is refused here: only machine config defines launcher commands.

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
| `flows.<flow>` | `enabled`, `schedule`, `concurrency`, `agent` for one flow    |

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
| `accounts.<name>`       | —            | `configDir`, `expectedEmail`, `agent` (default `claude`)          |
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
concurrency: 1
quietHours: "23:00-07:00"
repos:
  - { path: ~/code/my-app, repo: you/my-app, account: personal, baseBranch: main }
```
