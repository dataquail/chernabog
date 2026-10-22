---
title: The usage gate
description: How Chernabog decides an account has room for one more task.
---

Before `implement` or `address-review` starts a run, its gate (`Implement.gate`) checks the account, then the usage gate reads current usage and decides whether one more task fits. `review` and `re-review` have no gate, and neither does a [`human-initiated`](/chernabog/recipes/human-initiated/) flow, since a person starts each of its runs. Every refusal is recorded as the tick's skip reason.

| Agent      | Usage comes from                                              |
| ---------- | ------------------------------------------------------------- |
| `claude`   | Claude's usage endpoint, with the account's login token       |
| `codex`    | the rate limits its own sessions log under `$CODEX_HOME/sessions` |
| `opencode` | nothing; its runs aren't gated on usage                        |

## The decision

Usage is a fraction of each window's quota, `0`–`1`.

1. **Five-hour ceiling.** Refuse when five-hour usage ≥ `fiveHourCeiling`.
2. **Weekly headroom.** Otherwise compute

   ```
   headroom = (targetEndUsage − weekly used) − humanRatePerHour × hours until weekly reset
   ```

   and launch only when `headroom ≥ taskCostEstimate`.

So the gate spends toward `targetEndUsage` by the end of the week while leaving room for the use you'll add yourself.

| Key                | Default | Meaning                                              |
| ------------------ | ------- | ---------------------------------------------------- |
| `targetEndUsage`   | `0.95`  | weekly usage to aim for at reset                     |
| `taskCostEstimate` | `0.04`  | weekly quota one task is expected to cost            |
| `fiveHourCeiling`  | `0.4`   | five-hour usage at which no task starts              |
| `humanRatePerHour` | `0.005` | weekly quota you use per hour, reserved for you      |

```yaml
# ~/.config/chernabog/config.yaml
usageGate:
  targetEndUsage: 0.95
  taskCostEstimate: 0.04
  fiveHourCeiling: 0.4
  humanRatePerHour: 0.005
```

`usageGate` is all four keys or none. It applies to every account on the machine.

An account can opt out with `usageGate: none`, such as one that logs in with a token from `claude setup-token`, which cannot read usage. Its runs launch with the account still checked, and only the subscription's own limits stop a session:

```yaml
accounts:
  ci: { oauthTokenEnv: CLAUDE_CODE_OAUTH_TOKEN, usageGate: none }
```

**Example.** 60 % used, 50 h to reset: `0.95 − 0.60 − 0.005 × 50 = 0.10`, which covers a `0.04` task.
