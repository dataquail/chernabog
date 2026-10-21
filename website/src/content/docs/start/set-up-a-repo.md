---
title: Set up a repo
description: Scaffold .chernabog/, enroll the repo on your machine, and trust it.
---

```bash
chernabog install                   # once per machine: personas, accounts and the daemon; see Installation
cd ~/code/my-app
chernabog init                      # scaffold .chernabog/ with the default flows, and enroll the repo
git add .chernabog .gitignore && git commit -m "chore: set up chernabog" && git push
chernabog trust my-app              # approve the base branch's .chernabog/
chernabog labels my-app             # create the auto:* labels
chernabog doctor                    # check logins, gh scopes, labels, trust and the daemon
```

| Step     | Writes                                                                                 |
| -------- | -------------------------------------------------------------------------------------- |
| `install`| [machine config](/chernabog/start/installation/#set-up-the-machine)'s personas and accounts, and a launchd agent or systemd user unit running `chernabog daemon` |
| `init`   | `.chernabog/` (config, flows, prompts, stages, schema, `package.json`), a `.gitignore` entry for its `node_modules/`, and the repo's entry in `~/.config/chernabog/config.yaml` |
| `trust`  | the tree hash of `.chernabog/` on the base branch                                      |
| `labels` | the eight [labels](/chernabog/work/flows/#labels) on GitHub                            |

Re-running `init` rewrites only the generated schema and the [version pins](/chernabog/operate/versions/); it never overwrites any other file. `chernabog enroll` enrolls a repo without scaffolding, such as one a teammate already set up, and choosing again is running it again.

## Enroll

After scaffolding, `init` enrolls the repo on this machine, as `enroll` does. It asks only what it has to, in three steps:

1. **Personas.** With one [GitHub persona](/chernabog/reference/configuration/#github-personas) in machine config, or none, there's no question. With several, you pick which ones work in this repo.
2. **Flows, for each chosen persona,** even when there's only one. The first question offers "Accept the defaults", so enter takes them; then "Keep the current ones" when you're re-enrolling and they differ; then "Choose flows", a checklist prefilled with the current flows or the defaults. The defaults are the flows `config.yaml` doesn't turn off with `flows.<flow>.enabled: false`, and whose [runners](/chernabog/reference/configuration/#runners) include that persona's login. A flow that runs an agent machine config has no account for (its `flows.<flow>.agent`, its role agents in `flows.<flow>.agents`, or the repo's `agent`) is listed but can't be picked, and says why: `needs codex; add an account for each with chernabog setup`.
3. **Accounts.** The persona's own account, from the accounts for the repo's `agent`, or from all of them: with one there's no question, with several you pick. Then, for each other agent the chosen flows need that has several accounts, you pick one; those go in the persona's [`accounts`](/chernabog/reference/configuration/#enrolled-repos).

The answers go on the repo's entry in machine config: under `personas:`, per persona, when machine config has several GitHub logins or the entry already has personas; otherwise on the repo entry itself. Only the flows chosen are listed, and only those run; a flow `config.yaml` turns off, or leaves to its runners, still runs for you if you choose it. Flows already listed keep their settings, and so does the rest of the entry. Enrolling lists the flows by file name and runs none of their code, since `.chernabog/` isn't trusted yet.

| Flag               | Answers                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `--persona <a,b>`  | the personas that work in this repo                                      |
| `--flows <a,b>`    | the flows for every chosen persona; naming one that can't run here fails, with the reason |
| `--defaults`       | the team's defaults for every chosen persona                             |
| `--account <a,b>`  | accounts from machine config: the persona's own, and one for each other agent its flows need |
| `--name <name>`    | a short name, when two enrolled repos share one, such as two clones      |

`init` and `enroll` take the same flags. Piped and without them, each persona keeps the flows it lists, or gets the team's defaults; with several personas in machine config, a repo enrolled for the first time needs `--persona`.

The entry is keyed by the repo's `owner/name`, not its folder, so settings follow the repo. If the checkout moves, `init` at its new place finds the entry whose checkout is gone and, in a terminal, offers to point it there, keeping its settings; `enroll` there does the same without asking. If you decline, `init` doesn't enroll the checkout, and says to run `enroll --name <another name>` to run it alongside the one that moved. `chernabog unenroll <repo>` removes a repo and its settings from machine config.

## Queue work

Label an issue `auto:eligible`. On the repo's schedule — hourly by default, repos spread across the hour — the daemon runs `implement`'s trigger. When the machine has a free slot and the account's [usage gate](/chernabog/agents/usage-gate/) passes, it claims the oldest queued issue and carries it to a green pull request labelled `auto:needs-review`.

To see it happen now rather than at the next tick:

```bash
chernabog trigger implement --repo my-app   # a tick, with its gates
chernabog run implement --repo my-app       # one run, skipping the gates
```

## Try changes before merging

Two flags read the working copy's `.chernabog/` instead of the base branch's:

- `chernabog labels --from-checkout` creates the labels while the setup is still in review.
- `chernabog run <flow> --repo <name> --from-checkout` runs in the foreground. It needs the daemon stopped, since only one process may run the workflow engine.
