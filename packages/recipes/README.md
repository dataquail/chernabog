# @chernabog/recipes

Chernabog's recipes: complete flows, written from [`@chernabog/sdk`](https://www.npmjs.com/package/@chernabog/sdk)'s blocks, that a repo copies into its `.chernabog/` or imports from this package. Each recipe is documented at <https://dataquail.github.io/chernabog/recipes/>.

Its recipes are `implement`, `review`, `re-review`, `address-review` and `resolve-conflicts`, the review loop; `plan`, which splits a spec into an epic of sub-issues; `epic`, which works through an epic's tasks as pull requests, each based on the branch of the task it builds on; and `human-initiated`, the hybrid path.

`chernabog init` adds this package to a repo's `.chernabog/package.json`. You don't need to install it by hand.

## The recipe package format

Any npm package can hold recipes. This one is the first, and a company's own package is read in exactly the same way. Its `package.json` names them under `chernabog.recipes`:

```json
{
  "name": "@acme/chernabog-recipes",
  "version": "1.0.0",
  "peerDependencies": { "@chernabog/sdk": "^0.6.0" },
  "chernabog": {
    "recipes": {
      "deploy": {
        "description": "Deploys a merged pull request",
        "flow": "flows/deploy.ts",
        "prompts": ["prompts/deploy.md"],
        "stages": ["stages/smoke-test.ts"],
        "docs": "https://acme.example/chernabog/deploy"
      }
    }
  }
}
```

- `flow` is the recipe's flow, under `flows/`. `prompts` are the prompts it renders, under `prompts/`, and `stages` are the steps it runs, under `stages/`. The files keep the layout of a repo's `.chernabog/`, so a copy lands at the same path.
- The `@chernabog/sdk` peer range is the SDK versions its flows are written against.
- **Step names are public API.** A run in flight resumes by its step names, and a new version of the package reaches every repo that imports from it at once. Renaming a step is a breaking change for the package.

[Writing a recipe package](https://dataquail.github.io/chernabog/recipes/packages/) covers the format, the SDK range, type-checking, rehearsing and publishing.
