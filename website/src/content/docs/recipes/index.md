---
title: Recipes
description: Complete flows from recipe packages, which a repo copies into its .chernabog/ as code it owns, or imports and runs from the package.
---

A recipe is a complete flow: its trigger, its steps in order and its endings, written out from the [SDK's blocks](/chernabog/flows/sdk/), along with the prompts it renders. Recipes come in **recipe packages**, npm packages a repo installs in its `.chernabog/`. Chernabog's own are [`@chernabog/recipes`](https://www.npmjs.com/package/@chernabog/recipes). A company can publish its own package and share it across its teams. It works exactly the same way, and [Writing a recipe package](/chernabog/recipes/packages/) says how.

| Recipe | What it does |
| ------ | ------------ |
| [`implement`](/chernabog/recipes/implement/) | Implements the oldest `auto:eligible` or `auto:ship` issue unattended, and asks a reviewer from the pool once its pull request is green |
| [`review`](/chernabog/recipes/review/) | Reviews a pull request whose review is requested of the persona; an approval merges an `auto:ship` pull request |
| [`re-review`](/chernabog/recipes/re-review/) | Reviews again when asked, in its own review session; approves, or hands the pull request to a person |
| [`address-review`](/chernabog/recipes/address-review/) | Answers a review that requests changes on the persona's own pull request, in the session that wrote it |
| [`resolve-conflicts`](/chernabog/recipes/resolve-conflicts/) | Merges the base into the persona's own pull request when it conflicts, resolves the conflicts, and asks an approving reviewer to look again |
| [`plan`](/chernabog/recipes/plan/) | Turns an `auto:plan` spec issue into an epic of sub-issues, linked by what blocks what, once a person approves the agent's plan |
| [`epic`](/chernabog/recipes/epic/) | Works through an `auto:epic` issue's tasks as pull requests, each stacked on the branch of the task it builds on, and parks between changes to its layers |
| [`human-initiated`](/chernabog/recipes/human-initiated/) | The hybrid path: `chernabog start <issue>` opens a session with a person, then opens the pull request and asks for a review |

The first five are the [review loop](/chernabog/work/flows/): together, they take an issue to a reviewed pull request through GitHub's own review requests.

## Copy or import

A repo chooses, flow by flow, who owns each one:

- **Copy** a recipe, and the repo owns it. Its flow is written to `.chernabog/flows/<name>.ts`, with its prompts beside it. From then on the file is the repo's code: read it, edit it, reorder its steps. This is the default, and it needs no config.
- **Import** a recipe, and the team that publishes the package owns it. `config.yaml` names it with `flows.<name>.from`, there's no file in `flows/`, and the flow runs straight from the package, on the repo's SDK and the binary's core. A new version of the package reaches every repo that imports from it.

```yaml
# .chernabog/config.yaml
flows:
  review:
    from: "@chernabog/recipes/review"
  deploy:
    from: "@acme/chernabog-recipes/deploy"
```

A flow that has both a `from` and a file in `flows/` is an error, not a quiet pick of one.

Recipes are named `<package>/<recipe>`, such as `@acme/chernabog-recipes/deploy`. A bare name, such as `review`, means `@chernabog/recipes`.

## Choosing recipes

`chernabog init` adds `@chernabog/recipes` to `.chernabog/package.json`, at the newest version that supports the repo's SDK, and installs it. It then lists the recipes, each with its description and a link to its page here, and copies the ones you pick. Piped, it copies only the ones `--recipes` names:

```bash
chernabog init --recipes implement,review,re-review,address-review,resolve-conflicts
```

`init` and `recipes add` need the package installed, and the binary keeps no copy of the recipes. Without network access, `init` fails and says what to install.

Later, in a repo that's already set up:

```bash
chernabog recipes list                       # each installed package's recipes: ✓ copied, → imported
chernabog recipes add human-initiated        # copy one more; with none named, asks which
chernabog recipes add --import review        # import one instead
chernabog recipes add @acme/chernabog-recipes/deploy
```

Copying writes the recipe's flow and the prompts it renders when the repo doesn't have them. It never overwrites a file: a flow already there under the recipe's name is kept, and the command says so. It also records, in `.chernabog/package.json` under `chernabog.copied`, which package and version each file came from.

Importing writes `flows.<name>.from` and moves the package to `dependencies` in `.chernabog/package.json`, since a snapshot installs only those. A package you only copy from can stay in `devDependencies`.

Commit the changes, `.chernabog/bun.lock` included, merge them, and `chernabog trust` the repo. Then `chernabog enroll` chooses which personas run the flows.

A repo with no flows isn't enrolled: `init` says so, and enrolls it once a recipe or a flow of your own is there.

## A company's package, from a private registry

A company's recipe package is installed like any other: `bun add -d @acme/chernabog-recipes` in `.chernabog/`. Registries and auth come from `.chernabog/.npmrc`, so a private registry needs nothing of chernabog's:

```ini
# .chernabog/.npmrc
@acme:registry=https://npm.acme.example/
//npm.acme.example/:_authToken=${ACME_NPM_TOKEN}
```

`recipes list` then shows its recipes beside `@chernabog/recipes`'.

## Keeping up with a recipe

A copied recipe doesn't change on its own. Two commands bring over what the package changed:

- **`chernabog recipes diff`** shows how each copied file differs from the version of the recipe it came from: the repo's own edits. A file from before versions were recorded is compared with the version installed. Name recipes, as in `chernabog recipes diff review re-review`, to compare only those.
- **`chernabog recipes update`** moves each recipe package to its newest version that supports the repo's SDK, then brings each copied file along. A file you haven't edited is replaced. An edited one is merged 3-way, from the version it was copied from, so your edits stay. Where you and the package changed the same lines, the file gets conflict markers and the command says so. It writes to the working tree only and commits nothing. Review the changes, resolve any conflicts, and merge them.

An imported flow needs no update of its own: it runs whatever version of the package `.chernabog/bun.lock` pins. `recipes update` moves that pin too.

`chernabog recipes upgrade` is for a new SDK. It moves the repo to the SDK released with this binary and pins its core, then updates the copied recipes to the newest versions for that SDK. See [Versions](/chernabog/operate/versions/).

### A repo baked before recipes were packages

Before `@chernabog/recipes`, the binary baked the recipes itself, so such a repo's `.chernabog/` has no recipe package installed, and `recipes diff`, `update` and `upgrade` can't tell its flows from hand-written ones; `diff` and `upgrade` say so. Run `chernabog init` once in its checkout. It installs `@chernabog/recipes` in `.chernabog/` and overwrites nothing; when it asks which recipes to copy, pick none. Then `chernabog recipes diff` compares each baked flow with the version installed, which shows what the recipes changed since, such as [claim refs](/chernabog/flows/sdk/#claims) let go with `Claims.releasing` in `implement` and `human-initiated`. Bring those changes over by hand: `recipes update` keeps a file with no recorded version as it is and records it as from the version installed, its differences counted as your edits. Commit `.chernabog/`, `bun.lock` included, merge it, and `chernabog trust` the repo.

## Overriding a prompt of an imported flow

An imported flow's prompts are looked up in layers: the repo's `.chernabog/prompts/<name>.md` first, then the package's, then the SDK's default. Its steps are found the same way, in `.chernabog/stages/` before the package's. To change one prompt, write your own `.chernabog/prompts/<name>.md` and the flow keeps running from the package.

## Ejecting an imported flow

To diverge from the central version, eject the flow:

```bash
chernabog recipes eject deploy
```

This copies the flow into `.chernabog/flows/deploy.ts`, along with its prompts and steps (a prompt you overrode is kept). It records the version they came from and removes the `from`. The flow keeps running under the same name and settings, and from then on it's a copy: `recipes diff` shows your edits, and `recipes update` merges the package's later changes into them.

## Changing a copied recipe

A copied recipe is a flow like any other, so [Writing flows](/chernabog/flows/flows/) and [Composing flows](/chernabog/flows/composing/) apply. Two things to keep in mind:

- **Step names are journal keys.** A run in flight resumes by the names of the steps it finished, such as `claim`, `local-gate-1` or `review-2`. Renaming a step, or passing it a different `id`, makes a resumed run do that step again. Upgrading the SDK never renames them.
- **The trigger is policy too.** Each recipe's trigger is written out in the file: which labels queue an issue, which pull requests a persona reviews, what a person has (`auto:needs-human`). Change it there.
