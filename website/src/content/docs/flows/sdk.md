---
title: SDK services
description: The services @chernabog/sdk provides to flows and Effect steps.
---

`@chernabog/sdk` is on npm for types; at runtime the binary supplies its own copy. Each service is a layer, so a team can replace one with its own implementation, and tests can use fakes.

| Service    | Covers                                                                      |
| ---------- | --------------------------------------------------------------------------- |
| `Repo`     | the repo's merged settings: slug, base branch, labels, limits, gates, notes |
| `Run`      | the run: flow, run id and work item                                         |
| `GitHub`   | queued issues, claims, labels, comments, branches, pull requests, CI state  |
| `Agent`    | starting and resuming agent sessions through an [adapter](/chernabog/agents/adapters/) |
| `Git`      | commits ahead, changed files, pushes                                        |
| `Worktree` | one worktree per branch                                                     |
| `Usage`    | the account check and the [usage gate](/chernabog/agents/usage-gate/)        |
| `RunLog`   | the run's log                                                               |

```bash
cd .chernabog && bun install   # or npm, pnpm: dev dependencies, for the editor
```
