# Releasing

Chernabog ships three things, versioned separately:

| What                   | Version in                      | Tag                  | Goes to                                                                       |
| ---------------------- | ------------------------------- | -------------------- | ----------------------------------------------------------------------------- |
| the `chernabog` binary | `package.json`                  | `v<version>`         | GitHub release assets, per platform, and the `dataquail/homebrew-tap` formula |
| `@chernabog/sdk`       | `packages/sdk/package.json`     | `sdk-v<version>`     | npm                                                                           |
| `@chernabog/recipes`   | `packages/recipes/package.json` | `recipes-v<version>` | npm                                                                           |

`src/platform/version.ts` reads the root `package.json`, so `--version`, and the stamp a binary puts on machine config and `state.db` when it migrates them, follow it.

The root is release-please's `simple` type, with `package.json` as an extra file, not the `node` type. A `node` root takes `chernabog` as its component from `package.json`, and release-please 17 then skips a release PR that releases only the root: the combined PR's branch has no component, the root's is `chernabog`, and the mismatch is only a warning. That is how the merge of v0.4.0's release PR first created no release.

They are versioned separately because a repo's `.chernabog/package.json` pins the SDK at the version the binary bundles, and `chernabog doctor` reports any other version as drift. Bumping the SDK with every binary release would make each upgrade look like drift in every enrolled repo. A commit under `packages/sdk/` still releases both, since the binary bundles the SDK.

The recipes depend on the SDK, not on the binary, which bundles none of them: a repo installs `@chernabog/recipes` in its `.chernabog/` (`chernabog init` adds it), and copies its recipes in or imports them from there. So a commit only under `packages/recipes/` releases the recipes alone; the root package lists the folder in `exclude-paths`. The package's `@chernabog/sdk` peer range says which SDKs its flows are written against: widen it when a recipe works on a new SDK, and move it, in a release of its own, when a recipe needs one. `chernabog init` installs the package from npm, so a binary and a recipes release made from the same merge are both needed for a fresh `init`; the recipes publish finishes minutes after the binary's.

## Compatibility

The SDK version is the contract between a binary and a repo's flows. A repo's `.chernabog/package.json` pins the SDK its flows are written against, and the binary declares, in one place, the SDK range it runs: `SUPPORTED_SDK` in `src/kernel/sdk-support.value-object.ts`. Its top follows the minor it bundles, `BUNDLED_SDK_VERSION`, which release-please moves with `packages/sdk`'s version; its floor is `OLDEST_SUPPORTED_SDK`, kept by hand (such as `>=0.6.0 <0.8.0` once the SDK is 0.7). A repo pinned outside the range is refused as `incompatible`.

- **A release that moves the SDK's minor** (any `feat!:` under `packages/sdk/`, and most `feat:`s there before 1.0) moves the range's top by itself. When the new minor only adds to the SDK, so flows written against the previous minor still run, leave `OLDEST_SUPPORTED_SDK` where it is (0.7 kept 0.6), and make sure `@chernabog/recipes`' peer range includes the new minor; no repo needs to upgrade. When it breaks them, move `OLDEST_SUPPORTED_SDK` up to the new minor in the pull request that breaks them, and what follows applies. Every enrolled repo still on the old minor is then refused until someone runs `chernabog recipes upgrade` in it and merges the result, so the release notes should say so, and what changed for hand-written flows.
- **A release that changes machine config or `state.db`** needs nothing extra: whichever binary first runs a newer version keeps a copy of each in `~/.config/chernabog/backups/`, named for the version it came from, and stamps them with its own. Any version change does this, not only one that changes the shape.
- **A daemon picks up a new binary by itself.** It watches its own executable, drains (starts no new runs), and restarts once the runs executing finish. Runs in flight that started under an SDK the new binary doesn't run go to `needs-human`.

### Rolling back

There are no down migrations, so rolling back is restoring what the older binary left:

1. Install the older binary from its release's assets, as the README installs without Homebrew; the tap's formula only ever points at the latest release.
2. `chernabog stop`.
3. Restore its copies: `cp ~/.config/chernabog/backups/config.yaml.<version> ~/.config/chernabog/config.yaml`, and the same for `state.db`. `chernabog doctor` on the newer binary lists the copies kept.
4. `chernabog start`.

The older binary refuses newer files until they're restored, and says which copy to restore. Whatever the newer binary recorded after the upgrade is lost.

## The normal path

1. **Merge PRs with conventional titles.** Squash merges make the title the commit, and the **PR title** check enforces the format. `feat:` bumps the minor version, and `fix:` and `perf:` bump the patch. While a version is below 1.0, a breaking change (`feat!:` or a `BREAKING CHANGE:` footer) bumps the minor too. `chore:`, `docs:`, `ci:`, `test:` and `refactor:` release nothing.
2. **release-please keeps a release PR open** (`chore(main): release …`). It lists the versions and changelog entries that merging would produce, and every push to `main` updates it. The **Release** workflow also refreshes `bun.lock` on that branch when the SDK's version moves.
3. **Merge the release PR when you want to ship,** once its **Release PR** check passes. release-please finds what to release in the PR's body, which it parses as HTML, so a release note with text such as `<run>` reads as a tag and can hide a part: merged, the PR would release no such part. The check fails naming the part and the text. Edit the body to write the text as `&lt;run&gt;`, which runs the check again, and merge before the next push to `main` rewrites the body. The same run then:
   - tags the release and creates its GitHub release;
   - builds the binary on macOS (arm64, x64) and Linux (x64, arm64), checks that each one reports the tagged version, and attaches the tarballs and a `sha256` file to the release;
   - points `Formula/chernabog.rb` in `dataquail/homebrew-tap` at those tarballs, written by `scripts/homebrew-formula.ts`. A dispatched re-run of an older tag leaves the formula alone;
   - publishes `@chernabog/sdk` and `@chernabog/recipes` to npm with provenance, each under `latest`, or under the prerelease's name (`beta`) for a prerelease, skipping a version that is already there;
   - once that publish succeeds, builds the docs site in `website/` from the SDK's tag and deploys it to GitHub Pages (the **Docs** workflow). A release with no SDK version leaves the site as it was.

## When a release fails partway

The tag and GitHub release already exist, so run **Release** by hand with the tag (`v0.4.0`, `sdk-v0.1.1` or `recipes-v0.1.0`):

```sh
gh workflow run release.yml -f tag=v0.4.0
```

It rebuilds and replaces the assets, and publishes the SDK or the recipes unless that version is already on npm. A dispatch with an SDK tag deploys the docs again too. To redeploy the docs alone, from `main`:

```sh
gh workflow run docs.yml
```

## One-time setup

1. Give the `quailops` GitHub App these repository permissions, and approve the change on the org's installation:

   | Permission    | Access         | For                                                                          |
   | ------------- | -------------- | ---------------------------------------------------------------------------- |
   | Contents      | Read and write | the release branch, the `bun.lock` commit, tags, releases, the tap's formula |
   | Pull requests | Read and write | opening and updating the release PR                                          |
   | Issues        | Read and write | the `autorelease: pending` / `tagged` labels on that PR                      |

   Install it on `dataquail/chernabog` and `dataquail/homebrew-tap`, and add its app ID and private key as the `VERSION_BUMPER_APPID` and `VERSION_BUMPER_SECRET` repository secrets.

   It needs no bypass on the default branch ruleset. It never pushes to `main`: the release PR reaches `main` through a merge like any other.

2. In the repository settings, allow squash merging only, so every PR title becomes the commit on `main`.
3. Create the `chernabog` npm org, and add an `NPM_TOKEN` secret that can create packages in it. A granular token limited to selected packages cannot create a new one.
4. Once this lands, release what is already there: create a release at the commit it landed as for each half, then run **Release** for each:

   ```sh
   gh release create v0.3.0 --target <sha> --title v0.3.0 --notes "First release."
   gh release create sdk-v0.1.0 --target <sha> --title "sdk v0.1.0" --notes "First release."
   gh workflow run release.yml -f tag=v0.3.0
   gh workflow run release.yml -f tag=sdk-v0.1.0
   ```

   release-please takes these as the last releases, and only commits after them go into the next release PR.

5. On npmjs.com, add a trusted publisher to `@chernabog/sdk`: repository `dataquail/chernabog`, workflow `release.yml`. Then delete the `NPM_TOKEN` secret. Publishing then uses short-lived OIDC credentials, so there is no long-lived token to leak.
6. In the repository settings, under **Pages**, set the source to **GitHub Actions**, or:

   ```sh
   gh api -X POST repos/dataquail/chernabog/pages -f build_type=workflow
   ```

   The site is served at <https://dataquail.github.io/chernabog/>. Its `github-pages` environment deploys from `main` only, which is where Release runs.

7. For `@chernabog/recipes`, which came later: before its first release PR is merged, add an `NPM_TOKEN` secret again that can create packages in the `chernabog` org. Once `recipes-v0.1.0` is on npm, add the same trusted publisher to `@chernabog/recipes` and delete the secret again. If the first publish fails for want of a token, add one and run **Release** with `-f tag=recipes-v0.1.0`.
