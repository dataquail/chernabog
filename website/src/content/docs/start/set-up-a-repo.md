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
| `init`   | `.chernabog/` (config, flows, prompts, stages, schemas, `package.json`, your `local.yaml`), and a `.gitignore` entry for `local.yaml` |
| `enroll` | a `repos` entry in `~/.config/chernabog/config.yaml`, and the flows you chose in `local.yaml` |
| `trust`  | the tree hash of `.chernabog/` on the base branch                                      |
| `labels` | the eight [labels](/chernabog/work/flows/#labels) on GitHub                            |
| `install`| a launchd agent or systemd user unit running `chernabog daemon`                        |

Re-running `init` rewrites only the generated schemas and the [version pins](/chernabog/operate/versions/); it never overwrites any other file. `enroll --name` gives a short name when two enrolled repos share one.

In a terminal, `enroll` asks which of the repo's flows run on your machine, starting from what runs now; a flow whose [runners](/chernabog/reference/configuration/#runners) don't include your GitHub login starts unticked. Where your choice differs from the team's, it goes in `local.yaml` as `flows.<flow>.enabled`, and beats the team's: a flow `config.yaml` turns off, or leaves to its runners, still runs for you if you pick it. A choice that matches the team's is left out, so a later change to the team's config still reaches you. `--flows implement,review` chooses without asking; piped and without `--flows`, `enroll` leaves the choices as they are. It writes `local.yaml` from the template when you have none, so teammates who only enroll get one too. Run `enroll` again to choose again; it only updates the repo's entry. It lists the flows by file name and runs none of their code, since `.chernabog/` isn't trusted yet.

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
