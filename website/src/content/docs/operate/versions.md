---
title: Versions
description: The engines floor, the SDK pins, and what happens when a binary is too old.
---

One daemon runs every enrolled repo, so a repo can't choose its Chernabog. It states the oldest it runs on, in `.chernabog/package.json`:

```json
{ "engines": { "chernabog": ">=0.3.0" } }
```

| Binary vs. floor | Result                                                                          |
| ---------------- | ------------------------------------------------------------------------------- |
| older            | refuses the repo before reading anything else; `status` names the version it needs |
| same or newer    | runs it                                                                         |

`init` writes the floor at its own version for a new `.chernabog/`, adds it where missing, and raises it when it rewrites the schemas or pins — the repo can then rely on what this binary added. Otherwise it leaves the floor alone, so one person upgrading doesn't force everyone else to. It never lowers it.

## Pins

`.chernabog/package.json` pins `@chernabog/sdk` and `effect` as dev dependencies at the versions the binary bundles; they exist for editor types. At runtime the binary supplies its own copies of both to every module that imports them. `doctor` flags pins that have drifted; `init` updates them.

## Unknown keys

Keys in `config.yaml` the binary doesn't know fail the repo rather than being ignored: each is a typo or a setting from a newer Chernabog, and either may be a rule the team counts on. `doctor` reports a missing floor and a binary too old for it.
