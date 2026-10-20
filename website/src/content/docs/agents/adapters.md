---
title: Adapters
description: How Chernabog drives Claude Code, Codex, opencode or an agent of your own.
---

No flow depends on a specific agent. The SDK's `Agent` service calls an adapter, which starts or resumes a session in the worktree and returns the agent's final answer, checked against a JSON Schema.

| Adapter    | Start                                                                 | Resume                       | Answer                                         |
| ---------- | --------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------- |
| `claude`   | interactive `claude --session-id <id> --permission-mode auto` under a [launcher](/chernabog/agents/launchers/); `claude -p … --output-format stream-json` headless | `--resume <id>`              | a JSON file checked by a Stop hook; `--json-schema` headless |
| `codex`    | `codex exec --json --approve-for-me`, sandboxed to the workspace (network on, `.git` writable) | `codex exec resume <thread>` | `--output-schema`, `-o`                        |
| `opencode` | `opencode run --format json`                                          | `--session <id>`             | the last JSON object in its final message      |
| your own   | `agents.<name>.start`                                                 | `agents.<name>.resume`       | the last JSON object it prints                 |

Each piece of work has a stable session id, so a run that crashes mid-agent resumes the same session. Claude takes the id as given; Codex and opencode choose their own, which Chernabog records the moment they report it.

## Which agent runs

Each account in machine config belongs to one agent (`agent: codex`; `claude` by default). The repo's account decides which agent implements. `agent` in the repo's `config.yaml` overrides that, and `local.yaml` overrides the repo. A flow can name another agent for one step — `flows.review.agent: codex` reviews a Claude pull request with Codex — which then runs under that agent's account.

## Guarantees

- **Accounts.** A run refuses to start when the account is logged in as anyone but its `expectedEmail`, or Codex is logged in with an API key.
- **Tokens.** A Claude account with `oauthTokenEnv` logs in with the token in that variable, from `claude setup-token`. No other account sees it, and a `CLAUDE_CODE_OAUTH_TOKEN` left in your shell logs in none of them. Claude does not check a token until a session starts, so the account check only confirms it is set, and an `expectedEmail` it cannot show fails closed. Such a token cannot read usage either: the account needs `usageGate: none`, which launches without the [usage gate](/chernabog/agents/usage-gate/) and leaves the subscription's own limits to stop a session.
- **No pay-per-token fallback.** API keys are removed from every agent's environment.
- **Permissions.** Claude runs in auto mode; Codex with automatic approval inside its workspace sandbox. Chernabog never widens what the agent's own config grants.
- **opencode.** Its `--auto` approves everything not explicitly denied, so it is off unless you add it: `agents: { opencode: { args: [--auto] } }`.

## Your own agent

Define it in machine config. Templates fill in `{prompt}`, `{promptFile}`, `{sessionId}` and `{cwd}`.

```yaml
# ~/.config/chernabog/config.yaml
accounts:
  personal: { configDir: ~/.claude-personal, expectedEmail: you@example.com }
  codex: { agent: codex, configDir: ~/.codex }
agents:
  aider:
    start: [aider, --yes-always, --message-file, "{promptFile}"]
```

Agents of your own, Codex and opencode run headless under any launcher; `status` says so.
