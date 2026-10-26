---
title: Versions
description: Which repos a Chernabog binary runs, upgrading a repo's flows, and rolling back.
---

One daemon runs every enrolled repo, so a repo can't choose its Chernabog. Instead, a repo records one fact: the SDK version its flows are written against, as the `@chernabog/sdk` pin in `.chernabog/package.json`.

```json
{ "devDependencies": { "@chernabog/sdk": "0.6.0", "effect": "4.0.5" } }
```

The binary alone decides whether it runs that. Before 1.0 it runs the SDK minor it bundles, such as `>=0.6.0 <0.7.0`, since almost every minor breaks flows; `doctor` names the range.

| The repo's pin                                         | Result                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| in the range                                           | runs it                                                                   |
| older                                                  | `incompatible`: move its flows with `chernabog recipes upgrade`           |
| newer                                                  | `incompatible`: upgrade Chernabog                                         |
| missing, or `engines.chernabog` still set              | `incompatible`: `chernabog recipes upgrade` writes the pin and drops the floor |

A repo that [imports flows](/chernabog/recipes/#copy-or-import) from a recipe package is refused, naming the package, unless each package a `from` names is in `package.json`'s `dependencies`, is installed at the version `bun.lock` pins, and declares an `@chernabog/sdk` range that includes the SDK the binary runs. `chernabog recipes update` moves a package to the newest version that supports the repo's SDK.

A repo is also refused when a flow or step imports something the bundled SDK doesn't export, such as a removed `Review.fixTrigger`, so a removed export stops the repo before a run starts rather than partway through one. An incompatible repo is never loaded; every other repo keeps running. `status`, the live view and `doctor` show it as `incompatible`, with the reason.

## Upgrading a repo

`chernabog recipes upgrade`, in the repo's checkout, writes to the working tree and commits nothing, since `.chernabog/` is a person's to merge:

- it moves the `@chernabog/sdk` and `effect` pins to the binary's versions, and drops `engines.chernabog`;
- it moves each recipe package to its newest version for that SDK, and brings the copied recipes along, as [`recipes update`](/chernabog/recipes/#keeping-up-with-a-recipe) does: a file you haven't edited is replaced, and an edited one is merged from the version it was copied from. A copy from before versions were recorded is replaced, so review the diff and re-apply your edits;
- hand-written flows and steps are listed, with what each imports that the SDK no longer has.

Merge the result to the base branch and trust it again. `chernabog recipes diff` previews how the copied flows differ from the versions they came from.

## Unknown keys

Keys in `config.yaml` the binary doesn't know fail the repo rather than being ignored: each is a typo or a setting from a newer Chernabog, and either may be a rule the team counts on.

## Local state

Machine config and `state.db` are stamped with the Chernabog that last migrated them. Before a newer binary migrates either one, it keeps a copy in `~/.config/chernabog/backups/`, named for the version it came from, and says where; the newest three of each are kept, and `doctor` lists them. A binary that finds a stamp newer than itself refuses to read the file, and says how to restore its copy.

## Upgrading Chernabog

After `brew upgrade chernabog`, the daemon notices its binary changed. It starts no new runs, shows that it's draining in `status` and the live view, and restarts on the new binary once the runs executing now finish. Runs waiting on a signal, such as a review that may take days, don't hold it up.

Each run records the SDK it started under. At startup, a run in flight that started under an SDK the binary doesn't run is never resumed: it goes to `needs-human`, with a summary naming both versions, and its worktrees and claim are released as `chernabog cancel` releases them. A compatible one resumes.

## Rolling back

There are no down migrations. Install the older binary, `chernabog stop`, restore the copies it left (`cp ~/.config/chernabog/backups/config.yaml.<version> ~/.config/chernabog/config.yaml`, and the same for `state.db`), then `chernabog start`. What the newer binary recorded after the upgrade is lost with its files.
