# Releasing

Chernabog ships two things, versioned separately:

| What                   | Version in                  | Tag              | Goes to                                                                       |
| ---------------------- | --------------------------- | ---------------- | ----------------------------------------------------------------------------- |
| the `chernabog` binary | `package.json`              | `v<version>`     | GitHub release assets, per platform, and the `dataquail/homebrew-tap` formula |
| `@chernabog/sdk`       | `packages/sdk/package.json` | `sdk-v<version>` | npm                                                                           |

`src/version.ts` reads the root `package.json`, so `--version` and the `engines.chernabog` floor follow it.

The root is release-please's `simple` type, with `package.json` as an extra file, not the `node` type. A `node` root takes `chernabog` as its component from `package.json`, and release-please 17 then skips a release PR that releases only the root: the combined PR's branch has no component, the root's is `chernabog`, and the mismatch is only a warning. That is how the merge of v0.4.0's release PR first created no release.

They are versioned separately because a repo's `.chernabog/package.json` pins the SDK at the version the binary bundles, and `chernabog doctor` reports any other version as drift. Bumping the SDK with every binary release would make each upgrade look like drift in every enrolled repo. A commit under `packages/sdk/` still releases both, since the binary bundles the SDK.

## The normal path

1. **Merge PRs with conventional titles.** Squash merges make the title the commit, and the **PR title** check enforces the format. `feat:` bumps the minor version, and `fix:` and `perf:` bump the patch. While a version is below 1.0, a breaking change (`feat!:` or a `BREAKING CHANGE:` footer) bumps the minor too. `chore:`, `docs:`, `ci:`, `test:` and `refactor:` release nothing.
2. **release-please keeps a release PR open** (`chore(main): release …`). It lists the versions and changelog entries that merging would produce, and every push to `main` updates it. The **Release** workflow also refreshes `bun.lock` on that branch when the SDK's version moves.
3. **Merge the release PR when you want to ship.** The same run then:
   - tags the release and creates its GitHub release;
   - builds the binary on macOS (arm64, x64) and Linux (x64, arm64), checks that each one reports the tagged version, and attaches the tarballs and a `sha256` file to the release;
   - points `Formula/chernabog.rb` in `dataquail/homebrew-tap` at those tarballs, written by `scripts/homebrew-formula.ts`. A dispatched re-run of an older tag leaves the formula alone;
   - publishes `@chernabog/sdk` to npm with provenance, under `latest`, or under the prerelease's name (`beta`) for a prerelease, skipping a version that is already there;
   - once that publish succeeds, builds the docs site in `website/` from the SDK's tag and deploys it to GitHub Pages (the **Docs** workflow). A release with no SDK version leaves the site as it was.

## When a release fails partway

The tag and GitHub release already exist, so run **Release** by hand with the tag (`v0.4.0` or `sdk-v0.1.1`):

```sh
gh workflow run release.yml -f tag=v0.4.0
```

It rebuilds and replaces the assets, and publishes the SDK unless that version is already on npm. A dispatch with an SDK tag deploys the docs again too. To redeploy the docs alone, from `main`:

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
