---
title: Trust
description: The rules that keep committed flows from running code you haven't approved.
---

The daemon runs committed flows and steps unattended, so anyone who can change `.chernabog/` can run code on your machine. Four rules contain that.

1. **Base branch only.** Flows, steps and prompts are read from the base branch, never from the branch or worktree under work, so a pull request can't rewrite the flow that handles it.
2. **Pinned dependencies.** What they import comes from `.chernabog/package.json` and its lockfile, installed without install scripts into the base branch's snapshot. Trusting the tree trusts those versions. Nothing resolves from the checkout's own `node_modules`.
3. **Explicit trust.** `chernabog trust` records the tree hash of the base branch's `.chernabog/`. When it changes after a pull, that repo starts no new runs until you review the diff and trust it again, as with `direnv allow`. Trusting restarts the daemon on the new config once nothing is executing.
4. **People decide.** `humanOnly` goes into every agent prompt, and a change touching `humanOnlyPaths` goes to `auto:needs-human` instead of a pull request.

Agents keep the permissions their own CLI config grants; Chernabog runs Claude Code in auto mode and doesn't widen them. See [Adapters](/chernabog/agents/adapters/#guarantees).
