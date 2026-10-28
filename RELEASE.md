# Releasing

Chernabog ships four things, versioned separately, from one release PR:

| What                   | Version in                      | Tag                  | Goes to                                                                       |
| ---------------------- | ------------------------------- | -------------------- | ----------------------------------------------------------------------------- |
| the `chernabog` binary | `package.json`                  | `v<version>`         | GitHub release assets, per platform, and the `dataquail/homebrew-tap` formula |
| `@chernabog/core`      | `packages/core/package.json`    | `core-v<version>`    | npm                                                                           |
| `@chernabog/sdk`       | `packages/sdk/package.json`     | `sdk-v<version>`     | npm                                                                           |
| `@chernabog/recipes`   | `packages/recipes/package.json` | `recipes-v<version>` | npm                                                                           |

`src/platform/version.ts` reads the root `package.json`, so `--version`, and the stamp a binary puts on machine config and `state.db` when it migrates them, follow it.

The root is release-please's `simple` type, with `package.json` as an extra file, not the `node` type. A `node` root takes `chernabog` as its component from `package.json`, and release-please 17 then skips a release PR that releases only the root: the combined PR's branch has no component, the root's is `chernabog`, and the mismatch is only a warning. That is how the merge of v0.4.0's release PR first created no release.

The binary bundles core, so a commit under `packages/core/` releases both. It bundles neither the SDK nor the recipes: a repo installs `@chernabog/sdk` and `@chernabog/recipes` in its `.chernabog/`, at the versions it pins, so a commit only under `packages/sdk/` or `packages/recipes/` releases that package alone; the root package lists both folders in `exclude-paths`. The binary still reads `packages/sdk`'s version at build time: it is the SDK `chernabog init` and `chernabog recipes upgrade` pin a repo to.

The SDK peer-depends on a range of core, and the recipes on a range of the SDK. Those ranges are kept by hand: widen one when a package works on a new version, and move it, in a release of its own, when the package needs one. `chernabog init` installs both from npm, so a binary and an SDK or recipes release made from the same merge are both needed for a fresh `init`; the publishes finish minutes after the binary's. Core publishes before the SDK in that run, since the SDK names it.

## Compatibility

Core is the contract between a binary and a repo's flows ([ADR 0004](docs/adr/0004-core-abi.md)). A repo's installed SDK declares the core it needs as a peer range, and the binary declares, in one place, the cores it provides: `PROVIDED_CORE` in `src/kernel/core-support.value-object.ts`, whose head is `BUNDLED_CORE_VERSION`, which release-please moves with `packages/core`'s version. A repo whose SDK needs a core outside it is refused as `incompatible`.

- **Core only grows within a major.** A `feat:` under `packages/core/` adds to it and moves its minor; every published SDK whose range is `^1.x` keeps running. `packages/core/API.md` shows the change in review; CI's `published` job loads the oldest and newest SDK on npm that claim this core.
- **A breaking change to core is a major** (`feat!:` under `packages/core/`). Keep the old port as an adapter over the new one and add the old major to `PROVIDED_CORE`, so SDKs written for it keep running. Dropping a major from `PROVIDED_CORE` breaks every repo still on an SDK for it, until someone runs `chernabog recipes upgrade` there and merges the result: that is a major of Chernabog's own, and its release notes should say so.
- **A release of the SDK** breaks no repo by itself: each repo moves to it with `chernabog recipes upgrade` when it chooses. Make sure `@chernabog/recipes`' peer range includes it.
- **A release that changes machine config or `state.db`** needs nothing extra: whichever binary first runs a newer version keeps a copy of each in `~/.config/chernabog/backups/`, named for the version it came from, and stamps them with its own. Any version change does this, not only one that changes the shape.
- **A daemon picks up a new binary by itself.** It watches its own executable, drains (starts no new runs), and restarts once the runs executing finish. Runs in flight resume against the `.chernabog/` tree they started from; one that started under a core the new binary can't resume goes to `needs-human`.

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
   - publishes `@chernabog/core`, then `@chernabog/sdk`, and `@chernabog/recipes` to npm with provenance, each under `latest`, or under the prerelease's name (`beta`) for a prerelease, skipping a version that is already there;
   - once the SDK's or core's publish succeeds, builds the docs site in `website/` from its tag (the SDK's, when both ship) and deploys it to GitHub Pages (the **Docs** workflow). A release with neither leaves the site as it was.

## When a release fails partway

The tag and GitHub release already exist, so run **Release** by hand with the tag (`v0.4.0`, `core-v1.0.0`, `sdk-v0.1.1` or `recipes-v0.1.0`):

```sh
gh workflow run release.yml -f tag=v0.4.0
```

It rebuilds and replaces the assets, and publishes core, the SDK or the recipes unless that version is already on npm. A dispatch with a core or SDK tag deploys the docs again too. To redeploy the docs alone, from `main`:

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

8. For `@chernabog/core`, which came with #163: its first release is 1.0.0, which `release-as` in `release-please-config.json` pins. Before that release PR is merged, add an `NPM_TOKEN` secret again that can create packages in the `chernabog` org. Once `core-v1.0.0` is on npm, add the same trusted publisher to `@chernabog/core`, delete the secret, and remove `release-as` from core's entry, or every later release PR would release 1.0.0 again. If the first publish fails for want of a token, add one and run **Release** with `-f tag=core-v1.0.0`.
