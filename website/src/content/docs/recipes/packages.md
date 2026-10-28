---
title: Writing a recipe package
description: Publish your own recipes as an npm package that repos copy from or import, versioned against @chernabog/sdk.
---

A recipe package is an npm package whose `package.json` describes its recipes under a `chernabog` key. [`@chernabog/recipes`](https://github.com/dataquail/chernabog/tree/main/packages/recipes) is one. A company's package works exactly the same way: publish it to any registry, public or private, and every team installs it in their `.chernabog/` and copies or [imports](/chernabog/recipes/#copy-or-import) its recipes.

## The format

```text
acme-chernabog-recipes/
├── package.json
├── tsconfig.json
├── flows/
│   └── deploy.ts
├── prompts/
│   └── deploy.md
└── stages/
    └── smoke-test.ts
```

```json
{
  "name": "@acme/chernabog-recipes",
  "version": "2.1.0",
  "type": "module",
  "files": ["flows", "prompts", "stages"],
  "peerDependencies": { "@chernabog/sdk": ">=0.6.0 <0.8.0" },
  "devDependencies": {
    "@chernabog/sdk": "0.6.0",
    "@types/bun": "^1.3.0",
    "effect": "4.0.5",
    "typescript": "^5.9.3"
  },
  "chernabog": {
    "recipes": {
      "deploy": {
        "description": "Deploys a pull request once it merges",
        "flow": "flows/deploy.ts",
        "prompts": ["prompts/deploy.md"],
        "stages": ["stages/smoke-test.ts"],
        "docs": "https://wiki.acme.example/chernabog/deploy"
      }
    }
  }
}
```

| Key in a recipe | What it is |
| --------------- | ---------- |
| `description`   | One line, for the list a person chooses from |
| `flow`          | The recipe's flow, under `flows/`. Its default export is a `defineFlow(...)`, as a repo's own flow is |
| `prompts`       | The prompts it renders, under `prompts/` |
| `stages`        | The steps it runs with `step(...)`, under `stages/` |
| `docs`          | Where it's documented; `recipes list` shows it |

The files keep the layout of a repo's `.chernabog/`. A copy lands at the same path, and an imported flow finds its prompts and steps in the package, after any of the repo's own. A recipe is named after its key, so this one is `@acme/chernabog-recipes/deploy`.

A flow imports `@chernabog/sdk` and `effect` like any flow. At runtime chernabog always substitutes its own copies, whatever is installed. Any other package a recipe imports goes in its `dependencies`.

## The SDK range

The `@chernabog/sdk` peer dependency says which SDK versions the package's flows are written against. It's the contract between your package and the binaries that run it:

- `chernabog init`, `recipes add` and `recipes update` pick the **newest version of your package whose range includes the repo's SDK pin**. A repo on an older SDK keeps getting the last version that supported it.
- A repo that **imports** from your package is refused before any run starts, as `incompatible` and naming your package, if your range doesn't include the SDK the binary runs.

Widen the range when a new SDK runs your flows unchanged. Move it, in a release of its own, when a recipe needs a newer SDK.

## Step names are public API

A run in flight resumes by the names of the steps it finished: `claim`, `local-gate-1`, `deploy-2`. A new version of your package reaches every repo that imports from it at once, including runs that are waiting on a review or on CI. Renaming a step, or changing the `id` a step is given, makes those runs do that step again when they resume.

**Renaming a step is a breaking change.** Release it as a new major version, or, before 1.0, a new minor. Adding a step or changing what one does is not.

## Type-checking

Install `@chernabog/sdk`, `effect` and `@types/bun` as dev dependencies, at the versions you write against, and check the flows with `tsc --noEmit`. [`packages/recipes/tsconfig.json`](https://github.com/dataquail/chernabog/blob/main/packages/recipes/tsconfig.json) is a tsconfig you can copy:

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "preserve",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "types": ["bun"]
  },
  "include": ["flows/**/*.ts", "stages/**/*.ts"]
}
```

## Rehearsing

[`chernabog rehearse`](/chernabog/flows/rehearsing/) runs a flow end to end on a seeded repo, with stand-ins where the agent would be. To rehearse your package before you publish it, enroll a scratch repo that imports the recipe, and pass your package's checkout with `--package`:

```yaml
# the scratch repo's .chernabog/config.yaml
flows:
  deploy:
    from: "@acme/chernabog-recipes/deploy"
```

```bash
chernabog rehearse deploy --repo scratch --scenario .chernabog/rehearsals/deploy.yaml \
  --package ~/code/acme-chernabog-recipes
```

The rehearsal loads the flow, its prompts and its steps from your checkout, in place of any version installed in the scratch repo, and still checks your SDK range. Your edits take effect without a publish.

## Publishing

Publish it like any npm package: `npm publish`, to npm or to your company's registry. Teams install it in `.chernabog/` (`bun add -d @acme/chernabog-recipes`), with the registry and its auth in `.chernabog/.npmrc`. `chernabog recipes add --import` moves it to `dependencies` for a flow they import.

Use semver as the step-name rule above says. A patch or a minor that keeps every step name is safe to take in every repo at once, and a team that wants to hold back pins the version in its lockfile.
