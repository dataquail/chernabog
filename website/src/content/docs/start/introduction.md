---
title: Introduction
description: What Chernabog does, and where people stay in the loop.
---

Chernabog spends spare coding-agent capacity on queued work across your repos. A daemon on your machine runs **flows**: durable [Effect](https://effect.website) workflows built from an SDK of services for the job — GitHub, coding agents, git worktrees and usage budgets.

Teams commit flows to each repo in `.chernabog/`, the way husky commits git hooks. People stay at the edges:

| A person                         | Chernabog                                                     |
| -------------------------------- | ------------------------------------------------------------- |
| labels an issue `auto:eligible`  | claims the oldest, implements it test first in a worktree     |
| sets budgets and hours           | runs only within them, and only with weekly headroom to spare |
| answers escalations              | stops at `auto:needs-human` or `auto:needs-clarification`     |
| merges                           | reviews, fixes review comments, waits for CI                  |

## Requirements

| Need       | Notes                                                                    |
| ---------- | ------------------------------------------------------------------------ |
| OS         | macOS or Linux; Windows through WSL2                                     |
| Forge      | GitHub, through `gh` logged in with the `repo` scope                     |
| Agent      | Claude Code, Codex or opencode, or [your own](/chernabog/agents/adapters/#your-own-agent) |
| `git`      | any recent version                                                       |
| Launcher   | optional: Orca or tmux, for [interactive sessions](/chernabog/agents/launchers/) |

Chernabog is early. Expect config keys and SDK surface to move between minor versions.
