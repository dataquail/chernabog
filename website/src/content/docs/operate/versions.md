---
title: Versions
description: Which repos a Chernabog binary runs, upgrading a repo's flows, and rolling back.
---

One daemon runs every enrolled repo, so a repo can't choose its Chernabog. It chooses its blocks instead. Flows are written from `@chernabog/sdk`, which `.chernabog/package.json` lists in `dependencies`, and each snapshot of the base branch installs the version the repo pins: two repos on different SDKs run side by side.

```json
{
  "dependencies": { "@chernabog/sdk": "0.8.0" },
  "devDependencies": { "@chernabog/core": "1.0.0", "effect": "4.0.5" }
}
```

What the binary provides is `@chernabog/core`: the flow shape, the durable steps, the services, claims and markers, which the SDK is written against and re-exports. The binary always supplies its own copies of core and `effect`, whatever is installed. Within a major, core only grows, so a new Chernabog keeps running the SDKs your repos already have ([ADR 0004](https://github.com/dataquail/chernabog/blob/main/docs/adr/0004-core-abi.md)).

The repo's one version fact is the range of core its installed SDK declares. The binary runs the repo when it provides a core in that range; `doctor` names what it provides.

| The repo                                                       | Result                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| its SDK needs a core this binary provides                      | runs it                                                                   |
| its SDK needs a newer core                                     | `incompatible`: upgrade Chernabog                                         |
| its SDK needs a core major this binary no longer provides      | `incompatible`: move it with `chernabog recipes upgrade`                  |
| no SDK in `dependencies`, or `engines.chernabog` still set     | `incompatible`: `chernabog recipes upgrade` lists the SDK and drops the floor |
| the core dev pin is newer than the binary's                    | `incompatible`: upgrade Chernabog                                         |

A repo that [imports flows](/chernabog/recipes/#copy-or-import) from a recipe package is refused, naming the package, unless each package a `from` names is in `package.json`'s `dependencies`, is installed at the version `bun.lock` pins, and declares an `@chernabog/sdk` range that includes the repo's SDK. `chernabog recipes update` moves a package to the newest version that supports the repo's SDK.

A repo is also refused when a flow or step imports from `@chernabog/core` something the binary's core doesn't export, so it stops before a run starts rather than partway through one. An incompatible repo is never loaded; every other repo keeps running. `status`, the live view and `doctor` show it as `incompatible`, with the reason.

## Upgrading a repo

`chernabog recipes upgrade`, in the repo's checkout, writes to the working tree and commits nothing, since `.chernabog/` is a person's to merge:

- it moves `@chernabog/sdk` to the version released with this binary (unless the repo lists a newer one), pins `@chernabog/core` and `effect` to the binary's versions, and drops `engines.chernabog`;
- it moves each recipe package to its newest version for that SDK, and brings the copied recipes along, as [`recipes update`](/chernabog/recipes/#keeping-up-with-a-recipe) does: a file you haven't edited is replaced, and an edited one is merged from the version it was copied from. A copy from before versions were recorded is replaced, so review the diff and re-apply your edits;
- hand-written flows and steps are listed, with what each imports from core that the binary's core doesn't have. Check what they import from the SDK against its changelog.

Merge the result to the base branch, with its `bun.lock`, and trust it again. `chernabog recipes diff` previews how the copied flows differ from the versions they came from. A repo whose recipes the binary baked, before they were a package, needs `chernabog init` first, to install one; see [a repo baked before recipes were packages](/chernabog/recipes/#a-repo-baked-before-recipes-were-packages).

## Unknown keys

Keys in `config.yaml` the binary doesn't know fail the repo rather than being ignored: each is a typo or a setting from a newer Chernabog, and either may be a rule the team counts on.

## Local state

Machine config and `state.db` are stamped with the Chernabog that last migrated them. Before a newer binary migrates either one, it keeps a copy in `~/.config/chernabog/backups/`, named for the version it came from, and says where; the newest three of each are kept, and `doctor` lists them. A binary that finds a stamp newer than itself refuses to read the file, and says how to restore its copy.

## Upgrading Chernabog

After `brew upgrade chernabog`, the daemon notices its binary changed. It starts no new runs, shows that it's draining in `status` and the live view, and restarts on the new binary once the runs executing now finish. Runs waiting on a signal, such as a review that may take days, don't hold it up.

Each run records the `.chernabog/` tree it started from and the core it started under. A run in flight resumes against that tree's snapshot, with the SDK that tree pinned, so neither a merge to `.chernabog/` nor a move of the repo's SDK changes the code under it. At startup, a run that started under a core the binary can't resume (another major, or a later version than it has) is never resumed: it goes to `needs-human`, with a summary naming both versions, and its worktrees and claim are released as `chernabog cancel` releases them.

## Rolling back

There are no down migrations. Install the older binary, `chernabog stop`, restore the copies it left (`cp ~/.config/chernabog/backups/config.yaml.<version> ~/.config/chernabog/config.yaml`, and the same for `state.db`), then `chernabog start`. What the newer binary recorded after the upgrade is lost with its files.
