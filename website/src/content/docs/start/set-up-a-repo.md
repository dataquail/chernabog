---
title: Set up a repo
description: Scaffold .chernabog/, enroll the repo on your machine, and start the daemon.
---

```bash
cd ~/code/my-app
chernabog init                      # scaffold .chernabog/ with the default flows
git add .chernabog .gitignore && git commit -m "chore: set up chernabog" && git push
chernabog enroll --account personal # add the repo to this machine's config, and pick its flows
chernabog trust my-app              # approve the base branch's .chernabog/
chernabog labels my-app             # create the auto:* labels
chernabog install                   # register the daemon with launchd or systemd, and start it
chernabog doctor                    # check logins, gh scopes, labels, trust and the daemon
```

| Step     | Writes                                                                                 |
| -------- | -------------------------------------------------------------------------------------- |
| `init`   | `.chernabog/` (config, flows, prompts, stages, schema, `package.json`), and a `.gitignore` entry for its `node_modules/` |
| `enroll` | a `repos` entry in `~/.config/chernabog/config.yaml`, with the flows you chose |
| `trust`  | the tree hash of `.chernabog/` on the base branch                                      |
| `labels` | the eight [labels](/chernabog/work/flows/#labels) on GitHub                            |
| `install`| a launchd agent or systemd user unit running `chernabog daemon`                        |

Re-running `init` rewrites only the generated schema and the [version pins](/chernabog/operate/versions/); it never overwrites any other file. `enroll --name` gives a short name when two enrolled repos share one, such as two clones of the same repo.

In a terminal, `enroll` asks which of the repo's flows run on your machine, starting from what runs now, or for a new repo from the team's defaults: the flows `config.yaml` doesn't turn off, and whose [runners](/chernabog/reference/configuration/#runners) include one of the repo's personas (else your GitHub login). It lists the ones you pick under `flows` on the repo's entry in machine config, and only those run; a flow `config.yaml` turns off, or leaves to its runners, still runs for you if you pick it. `--flows implement,review` chooses without asking. Piped and without `--flows`, `enroll` leaves the choices as they are, and a newly enrolled repo gets the team's defaults. Run `enroll` again to choose again; it updates only the keys it's given, so each flow's settings, the repo's personas and the rest of its entry survive. It lists the flows by file name and runs none of their code, since `.chernabog/` isn't trusted yet.

The entry is keyed by the repo's `owner/name`, not its folder, so settings follow the repo. If the checkout moves, `init` at its new place finds the entry whose checkout is gone and, in a terminal, offers to point it there, keeping its settings; `enroll` there does the same without asking. `chernabog unenroll <repo>` removes a repo and its settings from machine config.

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
