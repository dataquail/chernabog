---
title: Trust
description: The rules that keep committed flows from running code you haven't approved.
---

The daemon runs committed flows and steps unattended, so anyone who can change `.chernabog/` can run code on your machine. Four rules contain that.

1. **Base branch only.** Flows, steps and prompts are read from the base branch, never from the branch or worktree under work, so a pull request can't rewrite the flow that handles it.
2. **Pinned dependencies.** What they import comes from `.chernabog/package.json` and its lockfile, installed without install scripts into the base branch's snapshot. Trusting the tree trusts those versions. Nothing resolves from the checkout's own `node_modules`.
3. **Explicit trust.** `chernabog trust` records the tree hash of the base branch's `.chernabog/`. When it changes after a pull, that repo starts no new runs until you review the diff and trust it again, as with `direnv allow`. Trusting restarts the daemon on the new config once nothing is executing. A tree restarts it once: if its flows then fail to load, the repo shows as `error` until `.chernabog/` changes again, and the daemon doesn't keep restarting on it.
4. **People decide.** `humanOnly` goes into every agent prompt. An unattended run whose change touches `humanOnlyPaths` goes to `auto:needs-human` instead of a pull request, and chernabog never merges a pull request that touches them, whoever opened it.

`humanOnlyPaths` holds back unattended pushes and merges, not a person's session. On [the hybrid path](/chernabog/recipes/human-initiated/) a person is in the session as the agent writes the change, so it pushes and opens its pull request whatever it touches; so does [`address-review`](/chernabog/recipes/address-review/), and a fix for red CI, on a pull request a person worked on. A person still merges it.

That matters because a pull request from a branch in the same repo runs its own `.github/workflows/`, with the repo's secrets, as soon as it's pushed, before anyone reviews it. A person who watched the change written has seen what will run. An unattended run has no one watching, which is why it keeps the check.

GitHub accepts a push that changes `.github/workflows/` only from a token with the `workflow` scope (Workflows write, for a fine-grained token or a GitHub App). `gh auth login` grants it; a `GH_TOKEN` you made yourself may not. Without it, the run goes to `auto:needs-human` and says the token lacks the scope. Add it with `gh auth refresh --hostname github.com --scopes workflow`, logged in as that account, or push the branch yourself.

Agents keep the permissions their own CLI config grants; Chernabog runs Claude Code in auto mode and doesn't widen them. See [Adapters](/chernabog/agents/adapters/#guarantees).
